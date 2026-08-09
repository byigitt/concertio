import { sql, sqlOne } from '@/lib/db/client';
import { SourceCooldownError, withRetry } from '@/lib/http';
import { ingestEvents } from '@/lib/ingest';
import { resolveArtist } from '@/lib/matching';
import { scoreTaste } from '@/lib/scoring';
import { lastfm } from '@/lib/sources/lastfm';
import { ticketmaster } from '@/lib/sources/ticketmaster';
import { isReview, type ArtistResolution, type TasteSignal } from '@/lib/types';

/**
 * Bir kullanicinin taste + etkinlik yenilemesi. `pnpm faz0` ve `/api/jobs/run`
 * worker'i AYNI bu fonksiyonu cagirir; mantik tek yerde durur.
 *
 * RESUMABLE tasarim: serverless zaman siniri (Vercel `maxDuration`) uzun bir
 * koşuyu keser. O yuzden fonksiyon `timeBudgetMs` aliyor ve butce dolunca
 * `done:false` + guncel `cursor` donuyor; sonraki cagri ayni yerden devam ediyor.
 * Butce olmadan tasarlarsak 60+ sanatcili bir kullanici prod'da asla bitmez.
 *
 * Sanatci sirasi DETERMINISTIK olmali (skor DESC, isim ASC) — yoksa cursor
 * anlamsizlasir ve devam eden koşu farkli sanatcilari atlar.
 */

/** Kac sanatci islenecek. Faz 0'daki ile ayni varsayilan. */
const DEFAULT_ARTIST_LIMIT = Number(process.env.CONCERTIO_TOP_ARTISTS ?? 60);
/** Etkinlik penceresi (gun). */
const DEFAULT_WINDOW_DAYS = Number(process.env.CONCERTIO_WINDOW_DAYS ?? 180);
/** Metro merkezinden yaricap (km) — koordinatli mekanlar icin. */
const DEFAULT_RADIUS_KM = Number(process.env.CONCERTIO_METRO_RADIUS_KM ?? 80);
/** MusicBrainz cooldown (503) halinde sanatci basina deneme. */
const MB_ATTEMPTS = 3;
/** Cooldown taban beklemesi; her denemede katlanir. */
const MB_COOLDOWN_MS = 5_000;

/**
 * Bir kirada islenecek sanatci. Snapshot'in parcasi, DEGISMEZ.
 */
export interface RefreshWorkItem {
  artistName: string;
  mbid?: string;
  score: number;
  sources: TasteSignal[];
}

export interface RefreshCursor {
  /**
   * ILK kirada bir kez uretilen ve DEGISMEYEN is listesi.
   *
   * Neden snapshot: `processed` bir indeks. Eger her kirada Last.fm yeniden
   * cekilip yeniden siralanirsa, aradaki yeni scrobble'lar skorlari degistirir,
   * sira kayar ve devam eden koşu sanatci ATLAR ya da IKI KEZ isler. Sayaclar
   * tek basina yeterli degil; devam noktasinin sabit bir listeye isaret etmesi
   * gerekiyor. Snapshot ayrica her kirada bir Last.fm cagrisi tasarruf ediyor.
   */
  worklist?: RefreshWorkItem[];
  /** `worklist` icinde tamamlanan sanatci sayisi. Devam noktasi. */
  processed?: number;
  /** Ham Last.fm sinyal sayisi (snapshot aninda). */
  signals?: number;
  /** Snapshot'taki sanatci sayisi. */
  scored?: number;
  linked?: number;
  reviewed?: number;
  eventsSeen?: number;
  eventsInserted?: number;
  matches?: number;
  missingAttraction?: number;
  errors?: string[];
}

export interface RefreshOptions {
  lastfmUser: string;
  metroSlug: string;
  /** Bu sureden fazla calismaz; dolunca `done:false` doner. */
  timeBudgetMs: number;
  cursor?: RefreshCursor;
  artistLimit?: number;
  windowDays?: number;
  /** Etkinlik cekimini atla (taste + kimlik zincirini tek basina dogrulamak icin). */
  skipEvents?: boolean;
  /** Ilerlemeyi disariya bildirir (job heartbeat'i icin). */
  onProgress?: (cursor: RefreshCursor) => Promise<void>;
}

export interface RefreshResult {
  done: boolean;
  cursor: RefreshCursor;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Haversine, km. Metro merkezine olan uzakligi lokalde filtrelemek icin. */
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

/** MusicBrainz cooldown'ini bekleyerek sanatci cozumler; basarisizsa undefined. */
async function resolveWithCooldown(
  name: string,
  mbid: string | undefined,
  errors: string[],
): Promise<ArtistResolution | undefined> {
  for (let attempt = 0; attempt < MB_ATTEMPTS; attempt += 1) {
    try {
      return await resolveArtist({ name, mbid });
    } catch (error) {
      const cooldown = error instanceof SourceCooldownError;
      if (!cooldown || attempt === MB_ATTEMPTS - 1) {
        errors.push(`${name}: ${(error as Error).message}`);
        return undefined;
      }
      await sleep(Math.max(error.retryAfterMs ?? 0, MB_COOLDOWN_MS * (attempt + 1)));
    }
  }
  return undefined;
}

export async function refreshUser(options: RefreshOptions): Promise<RefreshResult> {
  const startedAt = Date.now();
  const outOfTime = (): boolean => Date.now() - startedAt >= options.timeBudgetMs;

  const cursor: RefreshCursor = {
    processed: 0,
    linked: 0,
    reviewed: 0,
    eventsSeen: 0,
    eventsInserted: 0,
    matches: 0,
    missingAttraction: 0,
    errors: [],
    ...options.cursor,
  };

  if (!lastfm.isConfigured()) throw new Error('LASTFM_API_KEY is not set');
  if (!options.skipEvents && !ticketmaster.isConfigured()) {
    throw new Error('TICKETMASTER_API_KEY is not set');
  }

  const metro = await sqlOne<{
    id: string;
    name: string;
    state: string | null;
    lat: number;
    lng: number;
  }>('SELECT id, name, state, lat, lng FROM metro_area WHERE slug = $1 AND active', [
    options.metroSlug,
  ]);
  if (!metro) throw new Error(`no active metro area: ${options.metroSlug}`);

  // Snapshot VARSA Last.fm'e hic gitme: liste degismez olmali, yoksa `processed`
  // indeksi kayar. Yeni scrobble'lar bir SONRAKI ise girer.
  let worklist = cursor.worklist;
  if (!worklist) {
    const signals = await lastfm.fetchTaste(options.lastfmUser);
    const limit = options.artistLimit ?? DEFAULT_ARTIST_LIMIT;
    worklist = scoreTaste(signals)
      .slice(0, limit)
      // Sira deterministik: skor DESC, isim ASC. Ayni skorda isim tiebreak eder.
      .sort((a, b) => b.score - a.score || a.artistName.localeCompare(b.artistName))
      .map((entry) => ({
        artistName: entry.artistName,
        mbid: entry.mbid,
        score: entry.score,
        sources: entry.sources,
      }));
    cursor.signals = signals.length;
    cursor.scored = worklist.length;
    cursor.worklist = worklist;
    cursor.processed = 0;
    // Snapshot'i ISLEMEDEN once kaydet: koşu hemen olurse liste kaybolmasin.
    await options.onProgress?.(cursor);
  }

  const user = await sqlOne<{ id: string }>(
    `INSERT INTO app_user (lastfm_user, home_metro_id) VALUES ($1, $2)
     ON CONFLICT (lastfm_user) DO UPDATE SET home_metro_id = COALESCE(app_user.home_metro_id, EXCLUDED.home_metro_id)
     RETURNING id`,
    [options.lastfmUser, metro.id],
  );
  if (!user) throw new Error('app_user upsert failed');

  const startsAfter = new Date();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const startsBefore = new Date(Date.now() + windowDays * 86_400_000);
  const errors = cursor.errors ?? [];

  for (let index = cursor.processed ?? 0; index < worklist.length; index += 1) {
    if (outOfTime()) {
      cursor.processed = index;
      cursor.errors = errors.slice(0, 10);
      await options.onProgress?.(cursor);
      return { done: false, cursor };
    }

    const entry = worklist[index];
    if (!entry) continue;

    /**
     * TEK CIKIS + KASITLI ILERLEME.
     *
     * `finally` her turda checkpoint yazar (heartbeat sonmesin, kira kaybi
     * hemen gorulsun). AMA cursor yalnizca `settled` ise ilerler: sanatci
     * gercekten bir sonuca ulastiysa (cozuldu / review'a dustu / hatasi
     * kaydedildi). Beklenmeyen bir istisna — ornek: DB dusmesi — cursor'u
     * ILERLETMEZ, yoksa is requeue edilirken o sanatci kalici olarak atlanir.
     */
    let settled = false;
    try {
      const resolution = await resolveWithCooldown(entry.artistName, entry.mbid, errors);
      if (!resolution) {
        // Hata `errors`'a yazildi; bu sanatci icin yapacak baska sey yok.
        settled = true;
        continue;
      }
      if (isReview(resolution)) {
        cursor.reviewed = (cursor.reviewed ?? 0) + 1;
        settled = true;
        continue;
      }

      await sql(
        `INSERT INTO user_taste (user_id, artist_id, score, sources, computed_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id, artist_id)
         DO UPDATE SET score = EXCLUDED.score, sources = EXCLUDED.sources, computed_at = now()`,
        [user.id, resolution.artistId, entry.score, entry.sources],
      );
      cursor.linked = (cursor.linked ?? 0) + 1;

      if (options.skipEvents) {
        settled = true;
        continue;
      }

      try {
        const attractionId = await withRetry(
          () => ticketmaster.resolveArtist?.(entry.artistName) ?? Promise.resolve(undefined),
        );
        if (!attractionId) {
          cursor.missingAttraction = (cursor.missingAttraction ?? 0) + 1;
        } else {
          const fetched = await withRetry(() =>
            ticketmaster.fetchEvents({ artistExternalId: attractionId, startsAfter, startsBefore }),
          );
          // Cografi filtre lokalde: kaynak sanatcinin TUM tarihlerini donuyor.
          const inMetro = fetched.events.filter((e) =>
            e.venue.lat !== undefined && e.venue.lng !== undefined
              ? withinRadius(e.venue.lat, e.venue.lng, metro.lat, metro.lng, DEFAULT_RADIUS_KM)
              : e.venue.state === metro.state,
          );
          const outcome = await ingestEvents(inMetro, metro.id);
          cursor.eventsSeen = (cursor.eventsSeen ?? 0) + outcome.seen;
          cursor.eventsInserted = (cursor.eventsInserted ?? 0) + outcome.eventsInserted;
        }
      } catch (error) {
        errors.push(`${entry.artistName} (ticketmaster): ${(error as Error).message}`);
      }
      settled = true;
    } finally {
      if (settled) cursor.processed = index + 1;
      cursor.errors = errors.slice(0, 10);
      // Kira kaybi burada firlar ve dongu durur — istenen davranis.
      await options.onProgress?.(cursor);
    }
  }

  const matched = await sqlOne<{ n: number }>(
    `SELECT count(DISTINCT e.id)::int AS n
       FROM user_taste ut
       JOIN event_artist ea ON ea.artist_id = ut.artist_id
       JOIN event e ON e.id = ea.event_id
      WHERE ut.user_id = $1 AND e.metro_area_id = $2
        AND e.starts_at > now() AND e.status <> 'cancelled'`,
    [user.id, metro.id],
  );
  cursor.matches = matched?.n ?? 0;
  cursor.errors = errors.slice(0, 10);
  return { done: true, cursor };
}
