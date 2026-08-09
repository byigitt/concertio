/**
 * Taste skorlama (docs/05-architecture.md §3).
 *
 * Formul:
 *   sig_lastfm_top(a)    = log1p(topWeight(a)) / log1p(max_a topWeight)
 *                          (period agirliklari adapter'da uygulandi; burada log
 *                          olcek 10.000 scrobble'in 100'u ezmesini engeller)
 *   sig_lastfm_loved(a)  = min(1, lovedCount(a) / LOVED_SATURATION)
 *   sig_lastfm_recent(a) = min(1, plays(a) / RECENT_SATURATION) * 2^(-gun / RECENT_HALF_LIFE_DAYS)
 *   sig_spotify_top(a)   = log1p(w) / log1p(max w)   (Faz 1'de Spotify sinyali nadir)
 *   sig_spotify_recent(a)= min(1, w / SPOTIFY_RECENT_SATURATION)
 *   sig_spotify_followed = 1
 *
 *   raw(a) = SIRALI toplam: her sinyal tipinin §3 taban agirligi, girdide FIILEN
 *   gorulen sinyal tiplerine oransal renormalize edilir (eksik kaynak cezasi yok;
 *   docs/05 §3 "eksik kaynak -> renormalize").
 *
 *   pop_penalty(a) = 1 / (1 + POP_PENALTY_SLOPE * max(0, log10(listeners) - POP_PENALTY_FLOOR_LOG10))
 *   ("herkes Radiohead dinliyor" sondurmesi; listenersGlobal yoksa 1)
 *
 *   score(a) = round(100 * raw(a) * pop_penalty(a)), 0-100 araligina kirpilir.
 */

import type { RawTasteSignal, TasteSignal } from '@/lib/types';

// §3 taban agirliklari; girdide gorulen sinyal tiplerine renormalize edilir.
const BASE_WEIGHTS: Record<TasteSignal, number> = {
  lastfm_top: 0.3,
  lastfm_loved: 0.1,
  lastfm_recent: 0.1,
  spotify_top: 0.25,
  spotify_recent: 0.1,
  spotify_followed: 0.15,
};

// Bu kadar loved track sanatciya tam loved sinyali verir.
const LOVED_SATURATION = 5;
// Son donemde bu kadar calma tam recent sinyali verir (§3: plays_son30gun/20).
const RECENT_SATURATION = 20;
// Recency decay yari omru: 30 gun once dinlenen sinyalin yarisi kadar sayilir.
const RECENT_HALF_LIFE_DAYS = 30;
// Spotify recent doygunlugu (§3: plays_son50track/10).
const SPOTIFY_RECENT_SATURATION = 10;
// Populerlik cezasi: 10k listener altinda ceza yok (log10(10000)=4).
const POP_PENALTY_FLOOR_LOG10 = 4;
const POP_PENALTY_SLOPE = 0.35;

const MS_PER_DAY = 86_400_000;

interface ArtistBucket {
  artistName: string;
  mbid?: string;
  listenersGlobal?: number;
  /** Sinyal tipi basina toplanmis ham agirlik. */
  weightBySignal: Map<TasteSignal, number>;
  /** lastfm_recent icin en guncel calma zamani (ms epoch). */
  lastPlayedMs?: number;
}

/** DB'deki norm_name'in TS yaklastirmasi: unaccent + lower + 'the ' + '&' + [^a-z0-9 ]. */
function normName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function scoreTaste(
  signals: RawTasteSignal[],
): Array<{ artistName: string; mbid?: string; score: number; sources: TasteSignal[] }> {
  const buckets = new Map<string, ArtistBucket>();
  const presentSignals = new Set<TasteSignal>();

  for (const s of signals) {
    presentSignals.add(s.signal);
    const key = normName(s.artistName);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { artistName: s.artistName, weightBySignal: new Map() };
      buckets.set(key, bucket);
    }
    bucket.mbid ??= s.mbid;
    if (s.listenersGlobal !== undefined) {
      bucket.listenersGlobal = Math.max(bucket.listenersGlobal ?? 0, s.listenersGlobal);
    }
    bucket.weightBySignal.set(s.signal, (bucket.weightBySignal.get(s.signal) ?? 0) + s.weight);
    if (s.signal === 'lastfm_recent' && s.lastPlayedAt) {
      const ms = Date.parse(s.lastPlayedAt);
      if (!Number.isNaN(ms)) {
        bucket.lastPlayedMs = Math.max(bucket.lastPlayedMs ?? 0, ms);
      }
    }
  }

  // Log-normalize edilen sinyaller icin global maksimumlar.
  let maxTop = 0;
  let maxSpotifyTop = 0;
  for (const b of buckets.values()) {
    maxTop = Math.max(maxTop, b.weightBySignal.get('lastfm_top') ?? 0);
    maxSpotifyTop = Math.max(maxSpotifyTop, b.weightBySignal.get('spotify_top') ?? 0);
  }

  // Eksik kaynak renormalizasyonu: yalniz girdide gorulen tipler pay alir.
  let weightSum = 0;
  for (const sig of presentSignals) weightSum += BASE_WEIGHTS[sig];
  if (weightSum === 0) return [];

  const now = Date.now();
  const results: Array<{
    artistName: string;
    mbid?: string;
    score: number;
    sources: TasteSignal[];
  }> = [];

  for (const b of buckets.values()) {
    let raw = 0;
    for (const [sig, w] of b.weightBySignal) {
      let value: number;
      switch (sig) {
        case 'lastfm_top':
          value = maxTop > 0 ? Math.log1p(w) / Math.log1p(maxTop) : 0;
          break;
        case 'lastfm_loved':
          value = Math.min(1, w / LOVED_SATURATION);
          break;
        case 'lastfm_recent': {
          const ageDays =
            b.lastPlayedMs !== undefined ? Math.max(0, (now - b.lastPlayedMs) / MS_PER_DAY) : 0;
          value = Math.min(1, w / RECENT_SATURATION) * 2 ** (-ageDays / RECENT_HALF_LIFE_DAYS);
          break;
        }
        case 'spotify_top':
          value = maxSpotifyTop > 0 ? Math.log1p(w) / Math.log1p(maxSpotifyTop) : 0;
          break;
        case 'spotify_recent':
          value = Math.min(1, w / SPOTIFY_RECENT_SATURATION);
          break;
        case 'spotify_followed':
          value = 1;
          break;
      }
      raw += (BASE_WEIGHTS[sig] / weightSum) * value;
    }

    let popPenalty = 1;
    if (b.listenersGlobal !== undefined && b.listenersGlobal > 0) {
      popPenalty =
        1 /
        (1 +
          POP_PENALTY_SLOPE * Math.max(0, Math.log10(b.listenersGlobal) - POP_PENALTY_FLOOR_LOG10));
    }

    results.push({
      artistName: b.artistName,
      mbid: b.mbid,
      score: Math.min(100, Math.max(0, Math.round(100 * raw * popPenalty))),
      sources: [...b.weightBySignal.keys()],
    });
  }

  results.sort((a, b) => b.score - a.score || a.artistName.localeCompare(b.artistName));
  return results;
}
