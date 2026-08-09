#!/usr/bin/env tsx
/**
 * Uygulamanin YAYDIGI string'lerin ingilizce oldugunu dogrular.
 * Kod yorumlarina bakmaz — onlar gelistirici notu, arayuz metni degil.
 */
import { ingestEvents } from '../src/lib/ingest.ts';
import { pool, sql, sqlOne } from '../src/lib/db/client.ts';
import { REACH_ORDER, REACH_TIERS } from '../src/lib/reach.ts';

const TURKISH = /[şğıçöüŞĞİÇÖÜ]/;
let failures = 0;

function check(label: string, value: string): void {
  const bad = TURKISH.test(value);
  const upper = value !== value.toLowerCase();
  console.log(`   ${bad ? 'FAIL' : 'OK  '} ${label}: "${value}"${upper ? ' [buyuk harf var]' : ''}`);
  if (bad) failures += 1;
}

console.log('[1] reach etiketleri');
for (const tier of REACH_ORDER) {
  check(`${tier}.label`, REACH_TIERS[tier].label);
  check(`${tier}.hint`, REACH_TIERS[tier].hint);
}

console.log('\n[2] ingest skip sebepleri');
const metro = await sqlOne<{ id: string }>("SELECT id FROM metro_area WHERE slug = 'sf-bay-area'");
if (!metro) throw new Error('sf-bay-area metro yok');
const result = await ingestEvents(
  [
    {
      source: 'ticketmaster',
      sourceId: 'STRING-CHECK-1',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      status: 'confirmed',
      venue: { name: 'String Check Venue' },
      artists: [],
      ticketUrls: [],
      payload: { marker: 'string-check' },
    },
  ],
  metro.id,
);
for (const s of result.skipped) check('skipped.reason', s.reason);

await sql("DELETE FROM event_source_record WHERE source_id = 'STRING-CHECK-1'");
await sql("DELETE FROM venue WHERE name = 'String Check Venue'");
await pool().end();

if (failures > 0) {
  console.error(`\n${failures} string ingilizce DEGIL`);
  process.exitCode = 1;
} else {
  console.log('\nYayilan string\'ler ingilizce.');
}
