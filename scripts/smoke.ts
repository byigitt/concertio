#!/usr/bin/env tsx
/**
 * Uctan uca duman testi — API key GEREKTIRMEZ.
 *
 * Kapsam: Ticketmaster fixture -> toRawEvent -> ingestEvents (venue cozumleme,
 * dedup_key, event_artist, event_source_record) -> canli MusicBrainz kimlik
 * cozumleme -> user_taste -> matchesForUser sorgusu.
 *
 * Key gerektiren tek sey adapter'larin HTTP katmani; onlar kendi fixture ve
 * canli throttle testleriyle dogrulandi. Bu script gerisini kanitlar.
 *
 * Idempotency: iki kez kosunca ikinci kosuda `unchanged` artmali,
 * `eventsInserted` 0 olmali.
 */
import { readFile } from 'node:fs/promises';
import { pool, sql, sqlOne } from '../src/lib/db/client.ts';
import { ingestEvents } from '../src/lib/ingest.ts';
import { matchesForUser } from '../src/lib/queries.ts';
import { tmEventsPageSchema, toRawEvent } from '../src/lib/sources/ticketmaster.ts';
import type { RawEvent } from '../src/lib/types.ts';

const LASTFM_USER = 'smoke-test-user';

// Fixture modul seviyesinde okunur: main() erken patlasa bile cleanup silinecek
// kayitlarin id'sini bilir.
const fixturePage = tmEventsPageSchema.parse(
  JSON.parse(await readFile('src/lib/sources/__fixtures__/ticketmaster-event.json', 'utf8')),
);
const FIXTURE_SOURCE_IDS = (fixturePage._embedded?.events ?? []).map((e) => e.id);

async function main(): Promise<void> {
  const metro = await sqlOne<{ id: string; slug: string }>(
    "SELECT id, slug FROM metro_area WHERE slug = 'sf-bay-area'",
  );
  if (!metro) throw new Error('sf-bay-area metro yok; pnpm db:migrate kos.');

  const raws = (fixturePage._embedded?.events ?? [])
    .map(toRawEvent)
    .filter((r): r is RawEvent => r !== undefined);
  console.log(
    `fixture: ${raws.length} etkinlik (${FIXTURE_SOURCE_IDS.length} kayit) -> ` +
      raws.map((r) => r.artists[0]?.name ?? '(sanatcisiz)').join(', '),
  );

  console.log('\n[1] ingest (1. kosu)');
  const first = await ingestEvents(raws, metro.id);
  console.log('   ', first);

  console.log('[2] ingest (2. kosu — idempotency)');
  const second = await ingestEvents(raws, metro.id);
  console.log('   ', second);
  if (second.eventsInserted !== 0) {
    throw new Error(`IDEMPOTENCY KIRIK: ikinci kosuda ${second.eventsInserted} yeni event`);
  }
  // Atlanan etkinlik (sanatcisiz) hic kaydedilmedigi icin `unchanged` sayisina
  // girmez; beklenen deger ilk kosuda GERCEKTEN yazilan event sayisi.
  const persisted = first.eventsInserted + first.eventsUpdated;
  if (second.unchanged !== persisted) {
    throw new Error(`IDEMPOTENCY KIRIK: unchanged=${second.unchanged}, beklenen ${persisted}`);
  }
  if (second.skipped.length !== first.skipped.length) {
    throw new Error('Atlanan etkinlik sayisi iki kosuda farkli.');
  }

  console.log('[3] DB durumu');
  for (const q of [
    'SELECT count(*)::int AS n FROM event',
    'SELECT count(*)::int AS n FROM event_artist',
    'SELECT count(*)::int AS n FROM event_source_record',
    'SELECT count(*)::int AS n FROM venue',
  ]) {
    const [row] = await sql<{ n: number }>(q);
    console.log(`    ${q.split('FROM ')[1]}: ${row?.n}`);
  }
  const events = await sql<{ title: string | null; starts_at: Date; venue: string; status: string; artists: string[] }>(
    `SELECT e.title, e.starts_at, v.name AS venue, e.status,
            array_agg(a.name ORDER BY ea.position) AS artists
       FROM event e
       JOIN venue v ON v.id = e.venue_id
       JOIN event_artist ea ON ea.event_id = e.id
       JOIN artist a ON a.id = ea.artist_id
      GROUP BY e.id, v.name
      ORDER BY e.starts_at`,
  );
  for (const e of events) {
    console.log(`    ${e.starts_at.toISOString()} | ${e.venue} | ${e.status} | ${e.artists.join(' + ')}`);
  }

  console.log('[4] taste ekle + eslesme sorgusu');
  const user = await sqlOne<{ id: string }>(
    `INSERT INTO app_user (lastfm_user, home_metro_id) VALUES ($1, $2)
     ON CONFLICT (lastfm_user) DO UPDATE SET home_metro_id = EXCLUDED.home_metro_id
     RETURNING id`,
    [LASTFM_USER, metro.id],
  );
  if (!user) throw new Error('app_user upsert basarisiz');

  const headliners = await sql<{ artist_id: string; name: string }>(
    `SELECT DISTINCT ea.artist_id, a.name
       FROM event_artist ea JOIN artist a ON a.id = ea.artist_id
      WHERE ea.billing = 'headliner'`,
  );
  for (const [i, h] of headliners.entries()) {
    await sql(
      `INSERT INTO user_taste (user_id, artist_id, score, sources)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, artist_id) DO UPDATE SET score = EXCLUDED.score`,
      [user.id, h.artist_id, 90 - i * 10, ['lastfm_top']],
    );
  }
  console.log(`    ${headliners.length} sanatci icin taste yazildi`);

  const matches = await matchesForUser({ lastfmUser: LASTFM_USER, metroSlug: metro.slug });
  console.log(`    matchesForUser -> ${matches.length} satir`);
  for (const m of matches) {
    console.log(
      `    ${m.startsAt.toISOString().slice(0, 16)} | ${m.artistName} (${m.score}) | ${m.venueName} | ${m.ticketUrls[0]?.url ?? '-'}`,
    );
  }
  if (matches.length === 0) {
    throw new Error('EN ONEMLI ADIM KIRIK: taste yazildi ama eslesme cikmadi.');
  }

  console.log('\nOK — ingest, dedup, kimlik cozumleme, eslesme sorgusu ucundan uca calisiyor.');
}

/**
 * Fixture artiklarini siler. Silinecek `source_id`'ler FIXTURE'DAN gelir —
 * prefix tahmini yapmak hem kayit kacirir hem gercek Ticketmaster kayitlarini
 * hedef alabilir (ilk surumde ikisi de oldu). Venue silme de sadece bu
 * eventlerin venue'lariyla sinirli; global orphan taramasi gercek veriyi vurur.
 */
async function cleanup(): Promise<void> {
  if (process.argv.includes('--keep')) return;
  await sql('DELETE FROM app_user WHERE lastfm_user = $1', [LASTFM_USER]);
  if (FIXTURE_SOURCE_IDS.length === 0) return;

  const touched = await sql<{ event_id: string; venue_id: string }>(
    `SELECT DISTINCT r.event_id, e.venue_id
       FROM event_source_record r
       JOIN event e ON e.id = r.event_id
      WHERE r.source = 'ticketmaster' AND r.source_id = ANY($1)`,
    [FIXTURE_SOURCE_IDS],
  );
  const eventIds = touched.map((t) => t.event_id);
  const venueIds = [...new Set(touched.map((t) => t.venue_id))];

  await sql("DELETE FROM event_source_record WHERE source = 'ticketmaster' AND source_id = ANY($1)", [
    FIXTURE_SOURCE_IDS,
  ]);
  // Event'i SADECE baska kaynak kaydi kalmadiysa sil. Fixture dedup ile onceden
  // var olan gercek bir event'e baglanmis olabilir; korumasiz DELETE o event'i
  // ve cascade ile diger kaynak kayitlarini goturur.
  if (eventIds.length > 0) {
    await sql(
      `DELETE FROM event
        WHERE id = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM event_source_record r WHERE r.event_id = event.id)`,
      [eventIds],
    );
  }
  if (venueIds.length > 0) {
    await sql(
      `DELETE FROM venue
        WHERE id = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM event WHERE event.venue_id = venue.id)`,
      [venueIds],
    );
  }
  console.log(`temizlendi: ${eventIds.length} event, ${venueIds.length} venue adayi`);
}

try {
  await main();
} finally {
  await cleanup();
  await pool().end();
}
