/**
 * MusicBrainz WS/2 adapteri — kimlik cozumlemesinin "kesin yol"u (docs/07 K-3).
 * Keysiz ama anlamli User-Agent zorunlu; 1 istek/sn limiti fetchJson tarafindan
 * source_config'ten okunup uygulanir (source: 'musicbrainz').
 * Dogrulanmis ornek cikti: docs/08-verified-findings.md §6.
 */
import { z } from 'zod';
import { fetchJson, HttpStatusError } from '@/lib/http';
import type { SourceId } from '@/lib/types';

const MB_BASE = 'https://musicbrainz.org/ws/2';

function mbUserAgent(): string {
  const ua = process.env.MUSICBRAINZ_USER_AGENT;
  if (!ua) {
    throw new Error(
      'MUSICBRAINZ_USER_AGENT gerekli (MusicBrainz anlamli User-Agent olmadan 503 doner).',
    );
  }
  return ua;
}

/**
 * Lucene ozel karakterlerini kacirir. MB arama sorgusu Lucene sozdizimi kabul
 * ettigi icin sanatci adindaki `"`, `+`, `!` vb. sorguyu bozabilir.
 */
function escapeLucene(s: string): string {
  return s.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');
}

const searchResponseSchema = z.object({
  artists: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        score: z.number(),
        disambiguation: z.string().optional(),
      }),
    )
    .default([]),
});

export async function searchArtist(
  name: string,
): Promise<Array<{ mbid: string; name: string; score: number; disambiguation?: string }>> {
  const query = encodeURIComponent(`artist:"${escapeLucene(name)}"`);
  const data = await fetchJson(
    `${MB_BASE}/artist/?query=${query}&fmt=json&limit=5`,
    searchResponseSchema,
    { source: 'musicbrainz', headers: { 'User-Agent': mbUserAgent() } },
  );
  return data.artists.map((a) => ({
    mbid: a.id,
    name: a.name,
    score: a.score,
    ...(a.disambiguation !== undefined ? { disambiguation: a.disambiguation } : {}),
  }));
}

const urlRelsResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  relations: z
    .array(
      z.object({
        type: z.string(),
        url: z.object({ resource: z.string() }).optional(),
      }),
    )
    .default([]),
});

/**
 * relation.type + URL deseni -> bizim SourceId + dis kimlik.
 * DIKKAT: ayni iliski tipi birden fazla URL dondurebilir (dogrulandi: Charli XCX'te
 * iki Spotify id'si, docs/08 §6) — hepsi dondurulur, "tek dogru id" varsayilmaz.
 */
function extractExternalId(
  relType: string,
  resource: string,
): { source: SourceId; id: string } | undefined {
  if (relType === 'songkick') {
    const m = resource.match(/\/artists\/(\d+)/);
    return m?.[1] ? { source: 'songkick', id: m[1] } : undefined;
  }
  if (relType === 'free streaming' || relType === 'streaming') {
    const m = resource.match(/open\.spotify\.com\/artist\/([A-Za-z0-9]+)/);
    return m?.[1] ? { source: 'spotify', id: m[1] } : undefined;
  }
  if (relType === 'last.fm') {
    const m = resource.match(/\/music\/([^/?#]+)/);
    return m?.[1] ? { source: 'lastfm', id: m[1] } : undefined;
  }
  if (relType === 'ticketing') {
    const m = resource.match(/ticketmaster\.[^/]+\/artist\/(\d+)/);
    return m?.[1] ? { source: 'ticketmaster', id: m[1] } : undefined;
  }
  return undefined;
}

export async function lookupUrlRels(mbid: string): Promise<{
  mbid: string;
  name: string;
  externalIds: Array<{ source: SourceId; id: string }>;
}> {
  const data = await fetchJson(
    `${MB_BASE}/artist/${encodeURIComponent(mbid)}?inc=url-rels&fmt=json`,
    urlRelsResponseSchema,
    { source: 'musicbrainz', headers: { 'User-Agent': mbUserAgent() } },
  );
  const externalIds: Array<{ source: SourceId; id: string }> = [];
  const seen = new Set<string>();
  for (const rel of data.relations) {
    if (!rel.url) continue;
    const ext = extractExternalId(rel.type, rel.url.resource);
    if (!ext) continue;
    const key = `${ext.source}:${ext.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    externalIds.push(ext);
  }
  return { mbid: data.id, name: data.name, externalIds };
}

const urlReverseResponseSchema = z.object({
  relations: z
    .array(
      z.object({
        artist: z.object({ id: z.string(), name: z.string() }).optional(),
      }),
    )
    .default([]),
});

/**
 * Spotify/Songkick URL'sinden MBID'ye KESIN gecis (docs/05 §2.2 adim 1).
 * URL MusicBrainz'de kayitli degilse 404 doner — bu NORMAL akis, hata degil:
 * sessizce undefined donulur.
 */
export async function reverseLookup(
  url: string,
): Promise<{ mbid: string; name: string } | undefined> {
  let data: z.infer<typeof urlReverseResponseSchema>;
  try {
    data = await fetchJson(
      `${MB_BASE}/url?resource=${encodeURIComponent(url)}&inc=artist-rels&fmt=json`,
      urlReverseResponseSchema,
      { source: 'musicbrainz', headers: { 'User-Agent': mbUserAgent() } },
    );
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 404) return undefined;
    throw error;
  }
  const rel = data.relations.find((r) => r.artist !== undefined);
  return rel?.artist ? { mbid: rel.artist.id, name: rel.artist.name } : undefined;
}
