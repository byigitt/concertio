#!/usr/bin/env tsx
/**
 * Deep-paging tavani ve iptal kapisi testi. API key GEREKTIRMEZ — `fetch` mock'lanir.
 *
 * Iki davranis dogrulanir:
 *   T1. Ticketmaster `fetchEvents` 1000 sonuc tavanina carpinca `complete=false`
 *       dondurur ve en fazla 10 sayfa ceker.
 *   T2. `refreshMetro` `complete=false` gorunce `markStaleCancelled` CAGIRMAZ
 *       (cancelled === null) — yoksa cekilmeyen sayfalardaki gercek etkinlikler
 *       yanlislikla iptal isaretlenir. `complete=true` oldugunda cagirir.
 */
import { pool, sql, sqlOne } from '../src/lib/db/client.ts';
import { refreshMetro } from '../src/lib/pipeline.ts';
import { ticketmaster } from '../src/lib/sources/ticketmaster.ts';
import type { EventFetchResult, EventSource, RawEvent } from '../src/lib/types.ts';

const TEST_SLUG = 'pagination-test-metro';
const ISO_SLUG = 'isolation-test-metro';
let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`   ${ok ? 'OK  ' : 'FAIL'} ${label} — ${detail}`);
  if (!ok) failures += 1;
}

/**
 * Ticketmaster sayfa cevabi taklidi.
 * `undatedIndex` verilirse o sirali kayit tarihsiz uretilir — `toRawEvent`
 * onu atlar ve bu da kumeyi eksik yapar (`complete=false` beklenir).
 */
function fakePage(
  pageNumber: number,
  totalPages: number,
  totalElements: number,
  undatedIndex?: number,
): string {
  const events = Array.from({ length: 100 }, (_, i) => ({
    id: `PAGTEST-${pageNumber}-${i}`,
    name: `Test Event ${pageNumber}-${i}`,
    url: 'https://example.test/e',
    // dates.start zorunlu ama icindeki alanlarin hepsi bos olabilir.
    dates: i === undatedIndex ? { start: {} } : { start: { dateTime: '2026-09-01T20:00:00Z' } },
    _embedded: {
      venues: [{ name: 'Test Venue', city: { name: 'San Francisco' }, state: { stateCode: 'CA' } }],
      attractions: [{ id: `ATTR-${pageNumber}-${i}`, name: `Test Artist ${pageNumber}-${i}` }],
    },
  }));
  return JSON.stringify({
    _embedded: { events },
    page: { size: 100, totalElements, totalPages, number: pageNumber },
  });
}

/** Sahte fetch kurar, fn'i kosar, sonra global fetch ve key'i geri koyar. */
async function withFakeTicketmaster(
  pageBody: (pageNumber: number) => string,
  fn: (requestedPages: number[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TICKETMASTER_API_KEY;
  process.env.TICKETMASTER_API_KEY = 'test-key';
  const requestedPages: number[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const pageNumber = Number(url.searchParams.get('page') ?? '0');
    requestedPages.push(pageNumber);
    return new Response(pageBody(pageNumber), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await fn(requestedPages);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TICKETMASTER_API_KEY;
    else process.env.TICKETMASTER_API_KEY = originalKey;
  }
}

async function testDeepPagingCap(): Promise<void> {
  console.log('\n[T1] deep-paging tavani -> complete=false');
  // 40 sayfa / 4000 sonuc: tavan 10. sayfada devreye girmeli.
  await withFakeTicketmaster(
    (page) => fakePage(page, 40, 4000),
    async (requestedPages) => {
      const result = await ticketmaster.fetchEvents({ metroSourceId: '382' });
      check('complete=false', result.complete === false, `complete=${result.complete}`);
      check('sayfa sayisi 10', requestedPages.length === 10, `istenen sayfalar: ${requestedPages.join(',')}`);
      check('etkinlik sayisi 1000', result.events.length === 1000, `${result.events.length} etkinlik`);
      check('totalAvailable raporlandi', result.totalAvailable === 4000, `${result.totalAvailable}`);
    },
  );
}

async function testNormalizeLoss(): Promise<void> {
  console.log('\n[T1b] cevrilemeyen kayit -> complete=false (tavan asilmadan)');
  // Tek sayfa, tavan yok: complete'i bozan tek sey tarihsiz kayit olmali.
  await withFakeTicketmaster(
    (page) => fakePage(page, 1, 100, 7),
    async (requestedPages) => {
      const result = await ticketmaster.fetchEvents({ metroSourceId: '382' });
      check('tek sayfa cekildi', requestedPages.length === 1, `sayfa: ${requestedPages.join(',')}`);
      check('99 etkinlik cevrildi', result.events.length === 99, `${result.events.length} etkinlik`);
      check('complete=false', result.complete === false, `complete=${result.complete}`);
    },
  );

  console.log('   kontrol: kayipsiz sayfa complete=true kalmali');
  await withFakeTicketmaster(
    (page) => fakePage(page, 1, 100),
    async () => {
      const result = await ticketmaster.fetchEvents({ metroSourceId: '382' });
      check('complete=true', result.complete === true, `complete=${result.complete}`);
      check('100 etkinlik', result.events.length === 100, `${result.events.length} etkinlik`);
    },
  );
}

/** Sabit sonuc donduren sahte kaynak — `complete` bayragi disaridan verilir. */
function fakeSource(complete: boolean, events: RawEvent[]): EventSource {
  return {
    id: 'ticketmaster',
    limits: { requestsPerSecond: 100 },
    isConfigured: () => true,
    async fetchEvents(): Promise<EventFetchResult> {
      return { events, complete, totalAvailable: events.length };
    },
  };
}

const TEST_ARTIST_NAME = 'Gate Test Artist Unique';
const TEST_ATTRACTION_ID = 'PAGTEST-ATTRACTION-1';

function sampleEvent(sourceId: string, startsAt: string): RawEvent {
  return {
    source: 'ticketmaster',
    sourceId,
    title: 'Gate Test Show',
    startsAt,
    status: 'confirmed',
    venue: { name: 'Gate Test Venue', city: 'San Francisco', state: 'CA', lat: 37.77, lng: -122.41 },
    // externalId sart: kimlik cozumlemesi Kademe 0'dan (artist_external_id)
    // donsun ki test canli MusicBrainz'e cikmasin.
    artists: [
      { name: TEST_ARTIST_NAME, externalId: TEST_ATTRACTION_ID, billing: 'headliner', position: 0 },
    ],
    ticketUrls: [{ source: 'ticketmaster', url: 'https://example.test/t' }],
    payload: { id: sourceId, marker: startsAt },
  };
}

/** Sanatciyi ve dis kimligini onceden yazar — matching ag'a hic gitmez. */
async function seedArtist(): Promise<void> {
  const existing = await sqlOne<{ id: string }>('SELECT id FROM artist WHERE name = $1', [
    TEST_ARTIST_NAME,
  ]);
  const artistId =
    existing?.id ??
    (await sqlOne<{ id: string }>('INSERT INTO artist (name) VALUES ($1) RETURNING id', [
      TEST_ARTIST_NAME,
    ]))?.id;
  if (!artistId) throw new Error('test sanatcisi olusturulamadi');
  // Hem ticketmaster hem seatgeek icin yaz: T4'te ayni sanatci seatgeek
  // kaynagindan geliyor ve Kademe 0'da bulunamazsa canli MusicBrainz'e cikardi.
  for (const source of ['ticketmaster', 'seatgeek'] as const) {
    await sql(
      `INSERT INTO artist_external_id (artist_id, source, external_id, confidence, verified_via)
       VALUES ($1, $2, $3, 1.0, 'manual')
       ON CONFLICT (source, external_id) DO NOTHING`,
      [artistId, source, TEST_ATTRACTION_ID],
    );
  }
}

async function testCancellationGate(): Promise<void> {
  console.log('\n[T2] iptal kapisi');
  const metro = await sqlOne<{ id: string }>(
    `INSERT INTO metro_area (source, source_id, name, state, slug, active, lat, lng)
     VALUES ('ticketmaster_dma', 'PAGTEST-DMA', 'Pagination Test', 'CA', $1, true, 37.77, -122.41)
     ON CONFLICT (source, source_id) DO UPDATE SET active = true
     RETURNING id`,
    [TEST_SLUG],
  );
  if (!metro) throw new Error('test metro olusturulamadi');
  await seedArtist();

  // Iki tohum etkinlik: biri 90 gunluk cekim penceresi ICINDE, biri DISINDA.
  // Tarihler now()'a gore, sabit tarih yazmak testi bir sure sonra curutur.
  const inWindowAt = new Date(Date.now() + 45 * 86_400_000).toISOString();
  const outOfWindowAt = new Date(Date.now() + 150 * 86_400_000).toISOString();
  const seeded = await refreshMetro(
    fakeSource(true, [
      sampleEvent('PAGTEST-SEED-IN', inWindowAt),
      sampleEvent('PAGTEST-SEED-OUT', outOfWindowAt),
    ]),
    { id: metro.id, slug: TEST_SLUG, source_id: 'PAGTEST-DMA' },
    new Date(Date.now() - 60_000),
  );
  // Her dilim ayni iki etkinligi doner; dedup_key ayni oldugu icin iki satir olmali.
  check('iki tohum etkinlik yazildi', seeded.eventsInserted === 2, `inserted=${seeded.eventsInserted}`);

  check('ilk koşuda karsilastirma esigi yok', seeded.comparedAgainst === null, `${seeded.comparedAgainst}`);
  check('ilk koşuda iptal calismadi', seeded.cancelled === null, `cancelled=${seeded.cancelled}`);

  const statusOf = async (sourceId: string): Promise<string | undefined> =>
    (
      await sqlOne<{ status: string }>(
        `SELECT e.status FROM event e
           JOIN event_source_record r ON r.event_id = e.id
          WHERE r.source_id = $1`,
        [sourceId],
      )
    )?.status;

  // Eksik cekim: kaynak bos donuyor AMA complete=false -> iptal hic calismaz
  // ve karsilastirma esigi ILERLEMEZ (yoksa sonraki eksiksiz koşu tek yoklukla
  // iptale gecerdi).
  const incomplete = await refreshMetro(
    fakeSource(false, []),
    { id: metro.id, slug: TEST_SLUG, source_id: 'PAGTEST-DMA' },
    new Date(),
  );
  check('eksik koşu: cancelled=null', incomplete.cancelled === null, `cancelled=${incomplete.cancelled}`);
  const afterIncomplete = await sqlOne<{ n: number }>(
    "SELECT count(*)::int AS n FROM event WHERE metro_area_id = $1 AND status = 'cancelled'",
    [metro.id],
  );
  check('eksik koşu: hicbir iptal yok', afterIncomplete?.n === 0, `iptal sayisi=${afterIncomplete?.n}`);

  // BIRINCI eksiksiz yokluk: etkinlik gelmedi ama tek yokluk yetmez -> confirmed kalmali.
  const firstMiss = await refreshMetro(
    fakeSource(true, []),
    { id: metro.id, slug: TEST_SLUG, source_id: 'PAGTEST-DMA' },
    new Date(),
  );
  check('1. eksiksiz yokluk: iptal 0', firstMiss.cancelled === 0, `cancelled=${firstMiss.cancelled}`);
  check('1. eksiksiz yokluktan sonra confirmed', (await statusOf('PAGTEST-SEED-IN')) === 'confirmed', `${await statusOf('PAGTEST-SEED-IN')}`);

  // IKINCI eksiksiz yokluk: artik iki ardisik eksiksiz snapshot'ta yok -> iptal.
  const secondMiss = await refreshMetro(
    fakeSource(true, []),
    { id: metro.id, slug: TEST_SLUG, source_id: 'PAGTEST-DMA' },
    new Date(),
  );
  check('2. eksiksiz yokluk: iptal 1', secondMiss.cancelled === 1, `cancelled=${secondMiss.cancelled}`);
  check('2. eksiksiz yokluktan sonra cancelled', (await statusOf('PAGTEST-SEED-IN')) === 'cancelled', `${await statusOf('PAGTEST-SEED-IN')}`);
  check('pencere DISINDAKI etkinlik confirmed kaldi', (await statusOf('PAGTEST-SEED-OUT')) === 'confirmed', `${await statusOf('PAGTEST-SEED-OUT')}`);

  const watermark = await sqlOne<{ cursor: { complete: boolean; lastCompleteRunAt?: string } }>(
    'SELECT cursor FROM ingest_watermark WHERE source = $1 AND scope = $2',
    ['ticketmaster', TEST_SLUG],
  );
  check('watermark complete kaydediyor', watermark?.cursor.complete === true, JSON.stringify(watermark?.cursor));
  check(
    'watermark lastCompleteRunAt tutuyor',
    typeof watermark?.cursor.lastCompleteRunAt === 'string',
    `${watermark?.cursor.lastCompleteRunAt}`,
  );
}

/**
 * `unchanged` dalinin iki gorevi:
 *   T3a. Degismeyen etkinlik iptal edilmemeli — `fetched_at` tazelenmezse
 *        etkinlik "gorulmedi" sayilir ve iki eksiksiz koşu sonra iptal olur.
 *   T3b. Iptal edilmis etkinlik ayni payload'la geri gelirse `confirmed`'a
 *        donmeli — yoksa sonsuza kadar cancelled kalir.
 */
async function testUnchangedBranch(): Promise<void> {
  console.log('\n[T3] unchanged dali: hayatta kalma ve geri donus');
  const metro = await sqlOne<{ id: string }>('SELECT id FROM metro_area WHERE slug = $1', [TEST_SLUG]);
  if (!metro) throw new Error('test metro yok');
  const ref = { id: metro.id, slug: TEST_SLUG, source_id: 'PAGTEST-DMA' };

  const at = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const present = fakeSource(true, [sampleEvent('PAGTEST-STABLE', at)]);

  const run1 = await refreshMetro(present, ref, new Date());
  check('yeni etkinlik yazildi', run1.eventsInserted === 1, `inserted=${run1.eventsInserted}`);
  const run2 = await refreshMetro(present, ref, new Date());
  check('unchanged dalindan gecti', run2.unchanged > 0, `unchanged=${run2.unchanged}`);
  const run3 = await refreshMetro(present, ref, new Date());
  check('surekli gelen etkinlik iptal edilmedi', run3.cancelled === 0, `cancelled=${run3.cancelled}`);
  const stable = await sqlOne<{ status: string }>(
    "SELECT e.status FROM event e JOIN event_source_record r ON r.event_id = e.id WHERE r.source_id = 'PAGTEST-STABLE'",
  );
  check('etkinlik confirmed kaldi', stable?.status === 'confirmed', `status=${stable?.status}`);

  // Iki eksiksiz yokluk -> iptal.
  const absent = fakeSource(true, []);
  await refreshMetro(absent, ref, new Date());
  const missTwice = await refreshMetro(absent, ref, new Date());
  check('iki yoklukta iptal edildi', (missTwice.cancelled ?? 0) >= 1, `cancelled=${missTwice.cancelled}`);
  const afterMiss = await sqlOne<{ status: string }>(
    "SELECT e.status FROM event e JOIN event_source_record r ON r.event_id = e.id WHERE r.source_id = 'PAGTEST-STABLE'",
  );
  check('durum cancelled', afterMiss?.status === 'cancelled', `status=${afterMiss?.status}`);

  // AYNI payload ile geri geliyor: unchanged dalina duser, durum geri alinmali.
  const back = await refreshMetro(present, ref, new Date());
  check('geri donus unchanged dalinda', back.unchanged > 0, `unchanged=${back.unchanged}`);
  check('durum geri yuklendi (sayac)', back.statusRestored === 1, `statusRestored=${back.statusRestored}`);
  const restored = await sqlOne<{ status: string }>(
    "SELECT e.status FROM event e JOIN event_source_record r ON r.event_id = e.id WHERE r.source_id = 'PAGTEST-STABLE'",
  );
  check('etkinlik yeniden confirmed', restored?.status === 'confirmed', `status=${restored?.status}`);
}

/**
 * Kaynak izolasyonu: bir kaynagin eksiksiz bos snapshot'i, o kaynakta hic
 * gorunmemis (baska kaynaktan gelmis) bir etkinligi iptal edemez. Faz 1'de
 * SeatGeek ikincil kaynak olarak devreye girdiginde bu kural sart.
 */
async function testSourceIsolation(): Promise<void> {
  console.log('\n[T4] kaynak izolasyonu: TM taramasi SeatGeek-only etkinlige dokunmuyor');
  // Kendi metrosu: T3'ten kalan TM etkinlikleri sayaci kirletmesin.
  const metro = await sqlOne<{ id: string }>(
    `INSERT INTO metro_area (source, source_id, name, state, slug, active, lat, lng)
     VALUES ('ticketmaster_dma', 'PAGTEST-DMA2', 'Isolation Test', 'CA', $1, true, 37.77, -122.41)
     ON CONFLICT (source, source_id) DO UPDATE SET active = true
     RETURNING id`,
    [ISO_SLUG],
  );
  if (!metro) throw new Error('izolasyon metrosu olusturulamadi');
  const ref = { id: metro.id, slug: ISO_SLUG, source_id: 'PAGTEST-DMA2' };

  // SeatGeek'ten gelen bir etkinlik yaz (kaynak alanini degistirerek).
  const at = new Date(Date.now() + 20 * 86_400_000).toISOString();
  const sgEvent: RawEvent = {
    ...sampleEvent('PAGTEST-SG-ONLY', at),
    source: 'seatgeek',
    ticketUrls: [{ source: 'seatgeek', url: 'https://example.test/sg' }],
  };
  const sgSource: EventSource = { ...fakeSource(true, [sgEvent]), id: 'seatgeek' };
  await refreshMetro(sgSource, ref, new Date());
  const seeded = await sqlOne<{ status: string }>(
    "SELECT e.status FROM event e JOIN event_source_record r ON r.event_id = e.id WHERE r.source_id = 'PAGTEST-SG-ONLY'",
  );
  check('seatgeek etkinligi yazildi', seeded?.status === 'confirmed', `status=${seeded?.status}`);

  // Ticketmaster iki kez eksiksiz ve BOS donuyor: kendi watermark'i ilerliyor,
  // ama bu etkinligin TM kaydi hic olmadigi icin iptal edilmemeli.
  const tmEmpty = fakeSource(true, []);
  await refreshMetro(tmEmpty, ref, new Date());
  const tmSecond = await refreshMetro(tmEmpty, ref, new Date());
  check('TM taramasi 0 iptal etti', tmSecond.cancelled === 0, `cancelled=${tmSecond.cancelled}`);
  const after = await sqlOne<{ status: string }>(
    "SELECT e.status FROM event e JOIN event_source_record r ON r.event_id = e.id WHERE r.source_id = 'PAGTEST-SG-ONLY'",
  );
  check('seatgeek etkinligi confirmed kaldi', after?.status === 'confirmed', `status=${after?.status}`);
}

async function cleanup(): Promise<void> {
  for (const slug of [TEST_SLUG, ISO_SLUG]) {
    const metro = await sqlOne<{ id: string }>('SELECT id FROM metro_area WHERE slug = $1', [slug]);
    if (!metro) continue;
    await sql(
      'DELETE FROM event_source_record WHERE event_id IN (SELECT id FROM event WHERE metro_area_id = $1)',
      [metro.id],
    );
    await sql('DELETE FROM event WHERE metro_area_id = $1', [metro.id]);
    await sql('DELETE FROM venue WHERE metro_area_id = $1', [metro.id]);
    await sql('DELETE FROM ingest_watermark WHERE scope = $1', [slug]);
    await sql('DELETE FROM metro_area WHERE id = $1', [metro.id]);
  }
  await sql('DELETE FROM artist WHERE name = $1', [TEST_ARTIST_NAME]);
  console.log('\ntemizlendi');
}

try {
  await testDeepPagingCap();
  await testNormalizeLoss();
  await testCancellationGate();
  await testUnchangedBranch();
  await testSourceIsolation();
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
