#!/usr/bin/env tsx
/**
 * Yakinlik (reach) testleri. Ag ve API key GEREKTIRMEZ; DB gerekir
 * (`distance_m` ve filtre SQL'i gercek Postgres'te dogrulanir).
 *
 * T1. `distance_m` bilinen mesafeleri dogru veriyor.
 * T2. `classifyReach` kademeleri dogru siniflandiriyor.
 * T3. `matchesForUser` reach filtresi SQL'de gercekten kisitliyor.
 * T4. Ev konumu yoksa filtre yok sayiliyor (referans nokta olmadan filtre anlamsiz).
 */
import { pool, sql, sqlOne } from '../src/lib/db/client.ts';
import { matchesForUser, type HomeLocation } from '../src/lib/queries.ts';
import { classifyReach, formatDistance } from '../src/lib/reach.ts';

const SLUG = 'reach-test-metro';
const USER = 'reach-test-user';
const ARTIST = 'Reach Test Artist Unique';
let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`   ${ok ? 'OK  ' : 'FAIL'} ${label} — ${detail}`);
  if (!ok) failures += 1;
}

/** Ev: SF Civic Center. */
const HOME = { lat: 37.7793, lng: -122.4193, city: 'San Francisco', country: 'US' };

/** Bilinen mesafelerde mekanlar; her biri farkli bir kademeye dusmeli. */
const VENUES = [
  { name: 'Reach Walk Venue', lat: 37.7749, lng: -122.4194, city: 'San Francisco', country: 'US', expect: 'walk' },
  { name: 'Reach Transit Venue', lat: 37.8044, lng: -122.2712, city: 'Oakland', country: 'US', expect: 'transit' },
  { name: 'Reach Daytrip Venue', lat: 38.5816, lng: -121.4944, city: 'Sacramento', country: 'US', expect: 'daytrip' },
  { name: 'Reach Country Venue', lat: 34.0522, lng: -118.2437, city: 'Los Angeles', country: 'US', expect: 'country' },
  { name: 'Reach Abroad Venue', lat: 41.0082, lng: 28.9784, city: 'Istanbul', country: 'TR', expect: 'all' },
] as const;

async function testDistanceFunction(): Promise<void> {
  console.log('\n[T1] distance_m dogrulugu');
  const cases = [
    { label: 'ayni nokta', to: [HOME.lat, HOME.lng], max: 1 },
    // DIKKAT: duz hat, arac mesafesi degil. SF -> Oakland koprusuyle ~17 km
    // surulur ama kus ucusu 13,3 km. Bu ayrim kademe esiklerinin anlamini belirliyor.
    { label: 'SF -> Oakland (kus ucusu ~13 km)', to: [37.8044, -122.2712], min: 12_000, max: 15_000 },
    { label: 'SF -> Sacramento (~120 km)', to: [38.5816, -121.4944], min: 110_000, max: 130_000 },
    { label: 'SF -> Istanbul (~10.400 km)', to: [41.0082, 28.9784], min: 10_000_000, max: 11_000_000 },
  ];
  for (const c of cases) {
    const row = await sqlOne<{ d: number }>('SELECT distance_m($1, $2, $3, $4) AS d', [
      HOME.lat,
      HOME.lng,
      c.to[0],
      c.to[1],
    ]);
    const d = row?.d ?? -1;
    const ok = d >= (c.min ?? 0) && d <= c.max;
    check(c.label, ok, `${Math.round(d)} m (${formatDistance(d)})`);
  }
  const nullRow = await sqlOne<{ d: number | null }>('SELECT distance_m($1, $2, NULL, NULL) AS d', [
    HOME.lat,
    HOME.lng,
  ]);
  check('koordinatsiz mekan null', nullRow?.d === null, `${nullRow?.d}`);
}

function testClassify(): void {
  console.log('\n[T2] classifyReach kademeleri');
  check('1 km -> walk', classifyReach(1_000, true, true) === 'walk', 'walk');
  check('2 km sinirda -> walk', classifyReach(2_000, true, true) === 'walk', 'walk');
  check('2.1 km -> transit', classifyReach(2_100, true, true) === 'transit', 'transit');
  check('15 km sinirda -> transit', classifyReach(15_000, false, true) === 'transit', 'transit');
  check(
    '20 km ayni sehir -> city',
    classifyReach(20_000, true, true) === 'city',
    classifyReach(20_000, true, true),
  );
  check(
    '20 km farkli sehir -> daytrip',
    classifyReach(20_000, false, true) === 'daytrip',
    classifyReach(20_000, false, true),
  );
  check('600 km ayni ulke -> country', classifyReach(600_000, false, true) === 'country', 'country');
  check('yurtdisi -> all', classifyReach(10_000_000, false, false) === 'all', 'all');
  check(
    'koordinatsiz ama ayni sehir -> city',
    classifyReach(null, true, true) === 'city',
    classifyReach(null, true, true),
  );
}

async function seed(): Promise<void> {
  const metro = await sqlOne<{ id: string }>(
    `INSERT INTO metro_area (source, source_id, name, state, country, slug, active, lat, lng)
     VALUES ('ticketmaster_dma', 'REACHTEST', 'Reach Test', 'CA', 'US', $1, true, 37.7749, -122.4194)
     ON CONFLICT (source, source_id) DO UPDATE SET active = true
     RETURNING id`,
    [SLUG],
  );
  if (!metro) throw new Error('metro olusturulamadi');

  const artist = await sqlOne<{ id: string }>(
    'INSERT INTO artist (name) VALUES ($1) RETURNING id',
    [ARTIST],
  );
  if (!artist) throw new Error('sanatci olusturulamadi');

  const user = await sqlOne<{ id: string }>(
    `INSERT INTO app_user (lastfm_user, home_metro_id, home_label, home_lat, home_lng, home_city, home_country, home_set_at)
     VALUES ($1, $2, 'Test Home, San Francisco', $3, $4, $5, $6, now())
     RETURNING id`,
    [USER, metro.id, HOME.lat, HOME.lng, HOME.city, HOME.country],
  );
  if (!user) throw new Error('kullanici olusturulamadi');

  await sql(
    `INSERT INTO user_taste (user_id, artist_id, score, sources) VALUES ($1, $2, 90, $3)`,
    [user.id, artist.id, ['lastfm_top']],
  );

  for (const [index, v] of VENUES.entries()) {
    const venue = await sqlOne<{ id: string }>(
      `INSERT INTO venue (name, lat, lng, city, country, metro_area_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [v.name, v.lat, v.lng, v.city, v.country, metro.id],
    );
    if (!venue) throw new Error('venue olusturulamadi');
    const event = await sqlOne<{ id: string }>(
      `INSERT INTO event (dedup_key, venue_id, metro_area_id, title, starts_at, ticket_urls)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval, '[]')
       RETURNING id`,
      [`reach-test-${index}`, venue.id, metro.id, `Reach Test Show ${index}`, String(10 + index)],
    );
    if (!event) throw new Error('event olusturulamadi');
    await sql(
      `INSERT INTO event_artist (event_id, artist_id, billing, position) VALUES ($1, $2, 'headliner', 0)`,
      [event.id, artist.id],
    );
  }
}

async function testFilter(): Promise<void> {
  console.log('\n[T3] matchesForUser reach filtresi');
  const home: HomeLocation = {
    label: 'Test Home',
    lat: HOME.lat,
    lng: HOME.lng,
    city: HOME.city,
    state: 'California',
    country: HOME.country,
    setAt: new Date(),
  };

  const expected: Record<string, number> = {
    walk: 1,
    transit: 2,
    city: 2,
    daytrip: 3,
    country: 4,
    all: 5,
  };
  for (const [reach, count] of Object.entries(expected)) {
    // country/all metro sinirini asar; sayfa da bu durumda metroSlug vermiyor.
    const crossMetro = reach === 'country' || reach === 'all';
    const rows = await matchesForUser({
      lastfmUser: USER,
      metroSlug: crossMetro ? undefined : SLUG,
      reach: reach as never,
      home,
    });
    check(`${reach} -> ${count} satir`, rows.length === count, `${rows.length} satir`);
  }

  const all = await matchesForUser({ lastfmUser: USER, reach: 'all', home });
  for (const v of VENUES) {
    const row = all.find((r) => r.venueName === v.name);
    check(
      `${v.name} kademesi ${v.expect}`,
      row?.reach === v.expect,
      `${row?.reach} · ${formatDistance(row?.distanceMeters ?? null)}`,
    );
  }
}

async function testNoHome(): Promise<void> {
  console.log('\n[T4] ev konumu yoksa filtre yok sayilir');
  const rows = await matchesForUser({ lastfmUser: USER, reach: 'walk' });
  check('walk secili ama ev yok -> tum satirlar', rows.length === VENUES.length, `${rows.length} satir`);
  check('mesafe null', rows.every((r) => r.distanceMeters === null), 'hepsi null');
  check('kademe yok', rows.every((r) => r.reach === undefined), 'hepsi undefined');
}

async function cleanup(): Promise<void> {
  const metro = await sqlOne<{ id: string }>('SELECT id FROM metro_area WHERE slug = $1', [SLUG]);
  await sql('DELETE FROM app_user WHERE lastfm_user = $1', [USER]);
  if (metro) {
    await sql('DELETE FROM event WHERE metro_area_id = $1', [metro.id]);
    await sql('DELETE FROM venue WHERE metro_area_id = $1', [metro.id]);
    await sql('DELETE FROM metro_area WHERE id = $1', [metro.id]);
  }
  await sql('DELETE FROM artist WHERE name = $1', [ARTIST]);
  console.log('\ntemizlendi');
}

try {
  await cleanup();
  await seed();
  await testDistanceFunction();
  testClassify();
  await testFilter();
  await testNoHome();
} finally {
  await cleanup();
  await pool().end();
}

if (failures > 0) {
  console.error(`\n${failures} kontrol BASARISIZ`);
  process.exitCode = 1;
} else {
  console.log('\nTum kontroller gecti.');
}
