/**
 * Last.fm taste adapter (docs/02-lastfm.md).
 *
 * Period agirligi NEDEN burada uygulaniyor: `RawTasteSignal` kontratinda period
 * alani yok; scoring.ts sinyalin hangi period'dan geldigini goremez. Bu yuzden
 * `user.getTopArtists`'in uc period'u icin playcount daha bu katmanda period
 * carpaniyla olceklenir: overall x1.0, 12month x1.5, 1month x2.0. Yakin gecmis
 * daha guclu zevk sinyalidir (docs/05 §3'teki period agirliklamasinin adapter
 * tarafina tasinmis hali); ayni sanatci icin uc ayri sinyal uretilir ve
 * scoring.ts bunlari log olcekte toplayip normalize eder.
 */

import { z } from 'zod';
import type { ZodType } from 'zod';
import { fetchJson, SourceCooldownError } from '@/lib/http';
import type { RawTasteSignal, SourceLimits, TasteSource } from '@/lib/types';

const ROOT = 'https://ws.audioscrobbler.com/2.0/';

// Gercek limitler runtime'da source_config'ten okunur (fetchJson icinde, K-5).
// Buradaki degerler yalnizca source_config satiri yoksa devreye giren fallback.
const LIMITS: SourceLimits = {
  requestsPerSecond: 4,
  throttleMs: 250,
  cooldownOnStatuses: [429, 500, 502, 503],
};

const TOP_PERIODS = [
  { period: 'overall', weight: 1.0 },
  { period: '12month', weight: 1.5 },
  { period: '1month', weight: 2.0 },
] as const;

const TOP_LIMIT = 200;
const LOVED_PAGE_SIZE = 200;
const LOVED_MAX_TRACKS = 1000;
const RECENT_PAGE_SIZE = 200;
const RECENT_MAX_PAGES = 2;

// Last.fm MBID alanlari sikca bos string doner; bosu undefined'a cevir.
const mbidField = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

// Tek elemanli listelerde Last.fm bazen dizi yerine tek nesne dondurebilir.
function asArray<T>(item: ZodType<T>): ZodType<T[]> {
  return z.union([z.array(item), item.transform((x) => [x])]);
}

// Last.fm hatalari HTTP 200 govdesinde `{error, message}` olarak gelebilir.
const lastfmErrorSchema = z.object({
  error: z.number(),
  message: z.string(),
});

const pagingAttrSchema = z.object({
  page: z.coerce.number(),
  totalPages: z.coerce.number(),
});

const topArtistsSchema = z.object({
  topartists: z.object({
    artist: asArray(
      z.object({
        name: z.string(),
        playcount: z.coerce.number(),
        mbid: mbidField,
      }),
    ),
  }),
});

const lovedTracksSchema = z.object({
  lovedtracks: z.object({
    track: asArray(
      z.object({
        artist: z.object({
          name: z.string(),
          mbid: mbidField,
        }),
      }),
    ),
    '@attr': pagingAttrSchema,
  }),
});

const recentTracksSchema = z.object({
  recenttracks: z.object({
    track: asArray(
      z.object({
        artist: z.object({
          // extended=0'da sanatci adi '#text' alaninda gelir.
          '#text': z.string().optional(),
          name: z.string().optional(),
          mbid: mbidField,
        }),
        date: z.object({ uts: z.coerce.number() }).optional(),
        '@attr': z.object({ nowplaying: z.string().optional() }).optional(),
      }),
    ),
    '@attr': pagingAttrSchema,
  }),
});

function apiKey(): string {
  const key = process.env.LASTFM_API_KEY;
  if (!key) {
    throw new Error('LASTFM_API_KEY is not set; lastfm.isConfigured() should have been checked');
  }
  return key;
}

async function call<T>(
  method: string,
  params: Record<string, string>,
  schema: ZodType<T>,
): Promise<T> {
  const url = new URL(ROOT);
  url.searchParams.set('method', method);
  url.searchParams.set('api_key', apiKey());
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const data = await fetchJson(url.toString(), z.union([lastfmErrorSchema, schema]), {
    source: 'lastfm',
  });
  if (typeof data === 'object' && data !== null && 'error' in data) {
    const err = data as z.infer<typeof lastfmErrorSchema>;
    throw new Error(`Last.fm API hatasi ${err.error} (${method}): ${err.message}`);
  }
  return data as T;
}

async function fetchTopArtists(username: string): Promise<RawTasteSignal[]> {
  const signals: RawTasteSignal[] = [];
  for (const { period, weight } of TOP_PERIODS) {
    const data = await call(
      'user.gettopartists',
      { user: username, period, limit: String(TOP_LIMIT), page: '1' },
      topArtistsSchema,
    );
    for (const artist of data.topartists.artist) {
      signals.push({
        artistName: artist.name,
        mbid: artist.mbid,
        signal: 'lastfm_top',
        weight: artist.playcount * weight,
      });
    }
  }
  return signals;
}

async function fetchLovedTracks(username: string): Promise<RawTasteSignal[]> {
  const byArtist = new Map<string, { name: string; mbid?: string; count: number }>();
  const maxPages = Math.ceil(LOVED_MAX_TRACKS / LOVED_PAGE_SIZE);

  for (let page = 1; page <= maxPages; page++) {
    let data;
    try {
      data = await call(
        'user.getlovedtracks',
        { user: username, limit: String(LOVED_PAGE_SIZE), page: String(page) },
        lovedTracksSchema,
      );
    } catch (e) {
      // Kaynak cooldown'a girdiyse eldeki sayfalarla yetin; ilk sayfada bile
      // veri yoksa hatayi yukari tasi.
      if (e instanceof SourceCooldownError && page > 1) break;
      throw e;
    }
    for (const track of data.lovedtracks.track) {
      const key = track.artist.name.toLowerCase();
      const entry = byArtist.get(key);
      if (entry) {
        entry.count += 1;
        entry.mbid ??= track.artist.mbid;
      } else {
        byArtist.set(key, { name: track.artist.name, mbid: track.artist.mbid, count: 1 });
      }
    }
    if (page >= data.lovedtracks['@attr'].totalPages) break;
  }

  return [...byArtist.values()].map((a) => ({
    artistName: a.name,
    mbid: a.mbid,
    signal: 'lastfm_loved',
    weight: a.count,
  }));
}

async function fetchRecentTracks(username: string): Promise<RawTasteSignal[]> {
  const byArtist = new Map<
    string,
    { name: string; mbid?: string; count: number; lastUts: number }
  >();

  for (let page = 1; page <= RECENT_MAX_PAGES; page++) {
    let data;
    try {
      data = await call(
        'user.getrecenttracks',
        { user: username, limit: String(RECENT_PAGE_SIZE), page: String(page) },
        recentTracksSchema,
      );
    } catch (e) {
      if (e instanceof SourceCooldownError && page > 1) break;
      throw e;
    }
    for (const track of data.recenttracks.track) {
      // Henuz kesinlesmemis scrobble: nowplaying kaydini atla.
      if (track['@attr']?.nowplaying === 'true' || !track.date) continue;
      const name = track.artist.name ?? track.artist['#text'];
      if (!name) continue;
      const key = name.toLowerCase();
      const entry = byArtist.get(key);
      if (entry) {
        entry.count += 1;
        entry.lastUts = Math.max(entry.lastUts, track.date.uts);
        entry.mbid ??= track.artist.mbid;
      } else {
        byArtist.set(key, {
          name,
          mbid: track.artist.mbid,
          count: 1,
          lastUts: track.date.uts,
        });
      }
    }
    if (page >= data.recenttracks['@attr'].totalPages) break;
  }

  return [...byArtist.values()].map((a) => ({
    artistName: a.name,
    mbid: a.mbid,
    signal: 'lastfm_recent',
    weight: a.count,
    lastPlayedAt: new Date(a.lastUts * 1000).toISOString(),
  }));
}

export const lastfm: TasteSource = {
  id: 'lastfm',
  limits: LIMITS,

  isConfigured() {
    return Boolean(process.env.LASTFM_API_KEY);
  },

  async fetchTaste(handle) {
    const top = await fetchTopArtists(handle);
    const loved = await fetchLovedTracks(handle);
    const recent = await fetchRecentTracks(handle);
    return [...top, ...loved, ...recent];
  },
};
