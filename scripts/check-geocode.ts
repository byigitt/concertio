#!/usr/bin/env tsx
/** Nominatim geocoder canli kontrolu. Argumanlar adres olarak kullanilir. */
import { pool } from '../src/lib/db/client.ts';
import { geocode } from '../src/lib/geocode.ts';

const queries = process.argv.slice(2);
const targets = queries.length > 0 ? queries : ['1600 Market St, San Francisco', 'Berkeley, CA'];

for (const q of targets) {
  const hit = await geocode(q);
  if (!hit) {
    console.log(`${q} -> bulunamadi`);
    continue;
  }
  console.log(
    `${q} -> ${hit.lat.toFixed(4)},${hit.lng.toFixed(4)} | ` +
      `${hit.city ?? '-'} | ${hit.state ?? '-'} | ${hit.country ?? '-'}\n   ${hit.label}`,
  );
}

await pool().end();
