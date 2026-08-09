#!/usr/bin/env tsx
/**
 * Faz 0 (docs/07-roadmap-and-decisions.md): tek kullanici, tek metro, cron yok.
 *
 * Akis: Last.fm taste -> skorlama -> MusicBrainz kimlik cozumleme ->
 *       Ticketmaster artist-first etkinlik cekimi -> ingest -> terminal listesi.
 *
 * Artist-first (K-4): metro taramasi YAPILMIYOR. Her favori sanatci icin
 * Ticketmaster'a tek sorgu gidiyor, cografi filtre lokalde uygulaniyor.
 */
import { pool, sql, sqlOne } from '../src/lib/db/client.ts';
import { SourceCooldownError, withRetry } from '../src/lib/http.ts';
import { ingestEvents } from '../src/lib/ingest.ts';
import { resolveArtist } from '../src/lib/matching.ts';
import { scoreTaste } from '../src/lib/scoring.ts';
import { lastfm } from '../src/lib/sources/lastfm.ts';
import { ticketmaster } from '../src/lib/sources/ticketmaster.ts';
import { isReview, type ArtistResolution, type EventFetchResult } from '../src/lib/types.ts';

/** Faz 0'da kac sanatci taranacak. Ustu kuyruk/worker isi (docs §5.3 esigi). */
const TOP_ARTIST_LIMIT = Number(process.env.CONCERTIO_TOP_ARTISTS ?? 60);
/** Etkinlik penceresi: onumuzdeki N gun. */
const WINDOW_DAYS = Number(process.env.CONCERTIO_WINDOW_DAYS ?? 180);
/**
 * Metro merkezinden yaricap. SF Bay Area icin 80 km Santa Cruz'u ve Concord'u
 * iceri alir, Sacramento'yu almaz — Songkick'in metro tanimina yakin.
 */
const METRO_RADIUS_KM = Number(process.env.CONCERTIO_METRO_RADIUS_KM ?? 80);
/** MusicBrainz cooldown (503) halinde sanatci basina deneme sayisi. */
const MB_ATTEMPTS = 3;
/** Cooldown'da taban bekleme; her denemede katlanir. */
const MB_COOLDOWN_MS = 5_000;
/**
 * Tarihler mekan yerel saatinde gosterilir; UTC yazmak "02:30" gibi yaniltici
 * cikiyor (gercekte onceki aksam 19:30). Faz 1'de `metro_area.timezone` kolonu
 * eklenecek; simdilik tek aktif metro SF Bay oldugu icin sabit.
 */
const METRO_TZ = process.env.CONCERTIO_METRO_TZ ?? 'America/Los_Angeles';
const dateFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: METRO_TZ,
  dateStyle: 'short',
  timeStyle: 'short',
});

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function withinRadius(
  lat: number,
  lng: number,
  centerLat: number,
  centerLng: number,
  radiusKm: number,
): boolean {
  const toRad = Math.PI / 180;
  const dLat = (lat - centerLat) * toRad;
  const dLng = (lng - centerLng) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(centerLat * toRad) * Math.cos(lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h)) <= radiusKm;
}

interface Args {
  user: string;
  metroSlug: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  const user = flag('user') ?? process.env.CONCERTIO_LASTFM_USER;
  if (!user) {
    throw new Error('Kullanici yok. --user=<lastfm> ver veya CONCERTIO_LASTFM_USER ayarla.');
  }
  return { user, metroSlug: flag('metro') ?? 'sf-bay-area', dryRun: argv.includes('--dry-run') };
}

async function main(): Promise<void> {
  const args = parseArgs();

  const metro = await sqlOne<{
    id: string;
    name: string;
    state: string | null;
    lat: number;
    lng: number;
  }>(
    'SELECT id, name, state, lat, lng FROM metro_area WHERE slug = $1 AND active',
    [args.metroSlug],
  );
  if (!metro) throw new Error(`Aktif metro bulunamadi: ${args.metroSlug}`);

  console.log(`# concertio faz0 — ${args.user} @ ${metro.name}`);

  if (!lastfm.isConfigured()) {
    throw new Error(
      'LASTFM_API_KEY yok. https://www.last.fm/api/account/create adresinden ucretsiz al, .env.local dosyasina yaz.',
    );
  }
  // --dry-run etkinlik cekmiyor, o yuzden TM key'i sart degil: taste + kimlik
  // cozumleme zincirini tek basina dogrulamak icin bu mod kullanilabilir.
  if (!args.dryRun && !ticketmaster.isConfigured()) {
    throw new Error(
      'TICKETMASTER_API_KEY yok. https://developer.ticketmaster.com adresinden ucretsiz al, .env.local dosyasina yaz.',
    );
  }

  console.log('\n1/5 Last.fm taste cekiliyor');
  const signals = await lastfm.fetchTaste(args.user);
  console.log(`   ${signals.length} ham sinyal`);

  console.log('2/5 Skorlaniyor');
  const scored = scoreTaste(signals).slice(0, TOP_ARTIST_LIMIT);
  console.log(`   ${scored.length} sanatci (en yuksek: ${scored[0]?.artistName} ${scored[0]?.score.toFixed(1)})`);

  const userRow = await sqlOne<{ id: string }>(
    `INSERT INTO app_user (lastfm_user, home_metro_id) VALUES ($1, $2)
     ON CONFLICT (lastfm_user) DO UPDATE SET home_metro_id = EXCLUDED.home_metro_id
     RETURNING id`,
    [args.user, metro.id],
  );
  if (!userRow) throw new Error('app_user upsert basarisiz');

  console.log('3/5 Sanatci kimlikleri cozumleniyor (MusicBrainz 1 istek/sn)');
  const resolved: Array<{ artistId: string; name: string; score: number }> = [];
  let reviewed = 0;
  const failed: Array<{ name: string; reason: string }> = [];
  for (const entry of scored) {
    // Tek sanatcinin hatasi tum koşuyu dusurmemeli. MusicBrainz 503
    // (cooldown) tipik: bekleyip tekrar dene, sonra o sanatciyi atla.
    let resolution: ArtistResolution | undefined;
    for (let attempt = 0; attempt < MB_ATTEMPTS && !resolution; attempt += 1) {
      try {
        resolution = await resolveArtist({ name: entry.artistName, mbid: entry.mbid });
      } catch (error) {
        const cooldown = error instanceof SourceCooldownError;
        const last = attempt === MB_ATTEMPTS - 1;
        if (!cooldown || last) {
          failed.push({ name: entry.artistName, reason: (error as Error).message });
          break;
        }
        const waitMs = Math.max(error.retryAfterMs ?? 0, MB_COOLDOWN_MS * (attempt + 1));
        console.log(`   ${entry.artistName}: ${error.status}, ${waitMs} ms bekleniyor`);
        await sleep(waitMs);
      }
    }
    if (!resolution) continue;
    if (isReview(resolution)) {
      reviewed += 1;
      continue;
    }
    resolved.push({ artistId: resolution.artistId, name: entry.artistName, score: entry.score });
    await sql(
      `INSERT INTO user_taste (user_id, artist_id, score, sources, computed_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, artist_id)
       DO UPDATE SET score = EXCLUDED.score, sources = EXCLUDED.sources, computed_at = now()`,
      [userRow.id, resolution.artistId, entry.score, entry.sources],
    );
  }
  console.log(`   ${resolved.length} baglandi, ${reviewed} review kuyrugunda, ${failed.length} hata`);
  for (const f of failed.slice(0, 5)) console.log(`   ! ${f.name}: ${f.reason}`);

  if (args.dryRun) {
    console.log('\n--dry-run: etkinlik cekimi atlandi.');
    return;
  }

  console.log('4/5 Ticketmaster artist-first etkinlik cekimi');
  const startsAfter = new Date();
  const startsBefore = new Date(Date.now() + WINDOW_DAYS * 86_400_000);
  let totals = { seen: 0, inserted: 0, updated: 0, unchanged: 0 };
  let missingAttraction = 0;
  let truncated = 0;

  const tmFailed: Array<{ name: string; reason: string }> = [];

  for (const artist of resolved) {
    // Ag hatasi / gecici timeout tek sanatciyi atlatsin, koşuyu dusurmesin.
    let attractionId: string | undefined;
    try {
      attractionId = await withRetry(() => ticketmaster.resolveArtist?.(artist.name) ?? Promise.resolve(undefined));
    } catch (error) {
      tmFailed.push({ name: artist.name, reason: (error as Error).message });
      continue;
    }
    if (!attractionId) {
      missingAttraction += 1;
      continue;
    }
    let fetched: EventFetchResult;
    try {
      fetched = await withRetry(() =>
        ticketmaster.fetchEvents({ artistExternalId: attractionId, startsAfter, startsBefore }),
      );
    } catch (error) {
      tmFailed.push({ name: artist.name, reason: (error as Error).message });
      continue;
    }
    // Artist-first sorguda tavana carpmak pratikte imkansiz (tek sanatcinin
    // 1000+ tarihi olmaz) ama olursa sessiz gecmiyoruz.
    if (!fetched.complete) truncated += 1;
    // Cografi filtre lokalde (K-4): kaynak sanatcinin TUM tarihlerini dondurur,
    // biz metro merkezine gore yaricap icine kisiyoruz. Koordinati olmayan
    // etkinlik atlanmaz, eyalet kodu ile ikinci sansa girer.
    const inMetro = fetched.events.filter((e) => {
      if (e.venue.lat !== undefined && e.venue.lng !== undefined) {
        return withinRadius(e.venue.lat, e.venue.lng, metro.lat, metro.lng, METRO_RADIUS_KM);
      }
      return e.venue.state === metro.state;
    });
    const outcome = await ingestEvents(inMetro, metro.id);
    totals = {
      seen: totals.seen + outcome.seen,
      inserted: totals.inserted + outcome.eventsInserted,
      updated: totals.updated + outcome.eventsUpdated,
      unchanged: totals.unchanged + outcome.unchanged,
    };
  }
  console.log(
    `   ${totals.seen} etkinlik goruldu; ${totals.inserted} yeni, ${totals.updated} guncel, ${totals.unchanged} degismemis`,
  );
  if (missingAttraction > 0) {
    console.log(`   ${missingAttraction} sanatci icin Ticketmaster attraction id bulunamadi`);
  }
  if (tmFailed.length > 0) {
    console.log(`   ${tmFailed.length} sanatci Ticketmaster hatasi ile atlandi:`);
    for (const f of tmFailed.slice(0, 5)) console.log(`   ! ${f.name}: ${f.reason}`);
  }
  if (truncated > 0) {
    console.log(`   UYARI: ${truncated} sanatcinin sonuclari deep-paging tavaninda kirpildi`);
  }

  console.log('\n5/5 Eslesmeler');
  const matches = await sql<{
    starts_at: Date;
    artist: string;
    score: number;
    venue: string;
    city: string | null;
    ticket_urls: Array<{ url: string }>;
  }>(
    `SELECT e.starts_at, a.name AS artist, ut.score, v.name AS venue, v.city, e.ticket_urls
       FROM user_taste ut
       JOIN event_artist ea ON ea.artist_id = ut.artist_id
       JOIN event e ON e.id = ea.event_id
       JOIN venue v ON v.id = e.venue_id
       JOIN artist a ON a.id = ut.artist_id
      WHERE ut.user_id = $1
        AND e.metro_area_id = $2
        AND e.starts_at > now()
        AND e.status = 'confirmed'
      ORDER BY ut.score DESC, e.starts_at ASC`,
    [userRow.id, metro.id],
  );

  if (matches.length === 0) {
    console.log('   Eslesme yok. Sanatci sayisini artir (CONCERTIO_TOP_ARTISTS) veya pencereyi genislet.');
    return;
  }
  for (const m of matches) {
    const date = dateFormatter.format(m.starts_at);
    const where = m.city ? `${m.venue}, ${m.city}` : m.venue;
    console.log(`   ${date}  ${m.artist}  (${m.score.toFixed(0)})  ${where}`);
    console.log(`      ${m.ticket_urls[0]?.url ?? '-'}`);
  }
  console.log(`\n${matches.length} eslesme. Event data by Ticketmaster; taste data from Last.fm.`);
}

await main();
await pool().end();
