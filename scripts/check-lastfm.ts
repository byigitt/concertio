#!/usr/bin/env tsx
/**
 * Canli Last.fm dogrulamasi. `LASTFM_API_KEY` gerekir, DB gerekmez.
 *
 * Iki soruyu yanitlar:
 *   1. Sinyaller geliyor mu, skorlama makul mu?
 *   2. MBID doluluk orani ne? Bu oran dusukse her sanatci icin MusicBrainz
 *      aramasi gerekir ve 1 istek/sn limiti faz0'in suresini belirler.
 */
import { scoreTaste } from '../src/lib/scoring.ts';
import { lastfm } from '../src/lib/sources/lastfm.ts';
import type { TasteSignal } from '../src/lib/types.ts';

const user = process.argv[2] ?? process.env.CONCERTIO_LASTFM_USER ?? 'yeterli';

if (!lastfm.isConfigured()) {
  throw new Error('LASTFM_API_KEY yok (.env.local).');
}

console.log(`# Last.fm canli kontrol — ${user}`);
const started = Date.now();
const signals = await lastfm.fetchTaste(user);
console.log(`\n${signals.length} ham sinyal, ${((Date.now() - started) / 1000).toFixed(1)} sn`);

const bySignal = new Map<TasteSignal, number>();
for (const s of signals) bySignal.set(s.signal, (bySignal.get(s.signal) ?? 0) + 1);
for (const [signal, count] of [...bySignal].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${signal.padEnd(16)} ${count}`);
}

const withMbid = signals.filter((s) => s.mbid).length;
const uniqueNames = new Set(signals.map((s) => s.artistName.toLowerCase()));
const uniqueWithMbid = new Set(signals.filter((s) => s.mbid).map((s) => s.artistName.toLowerCase()));
console.log(
  `\nMBID doluluk: sinyal bazinda ${withMbid}/${signals.length} ` +
    `(%${((withMbid / Math.max(1, signals.length)) * 100).toFixed(0)}), ` +
    `sanatci bazinda ${uniqueWithMbid.size}/${uniqueNames.size} ` +
    `(%${((uniqueWithMbid.size / Math.max(1, uniqueNames.size)) * 100).toFixed(0)})`,
);

const scored = scoreTaste(signals);
console.log(`\nSkorlama -> ${scored.length} sanatci. Ilk 15:`);
for (const entry of scored.slice(0, 15)) {
  const mbid = entry.mbid ? 'mbid' : '  - ';
  console.log(`  ${String(Math.round(entry.score)).padStart(3)}  ${mbid}  ${entry.artistName}  [${entry.sources.join(',')}]`);
}

// faz0 suresini belirleyen sey: MBID'si olmayan sanatci sayisi x 1 istek/sn.
const top60 = scored.slice(0, 60);
const needsSearch = top60.filter((e) => !e.mbid).length;
console.log(
  `\nfaz0 tahmini: ilk 60 sanatcinin ${needsSearch} tanesi MBID'siz -> ` +
    `MusicBrainz aramasi gerekir, ~${needsSearch} sn ek sure (1 istek/sn).`,
);
