import { createHash } from 'node:crypto';
import { sql, sqlOne, tx } from '@/lib/db/client';
import { resolveArtist } from '@/lib/matching';
import {
  isReview,
  type ArtistResolution,
  type RawEvent,
  type RawTicketUrl,
  type SourceId,
} from '@/lib/types';

/**
 * Ham etkinlikleri kanonik `event` tablosuna yazar.
 * docs/05-architecture.md §1.1 (dedup) ve §4 (idempotency) uygulanir.
 *
 * Iki katman:
 *   1. `event_source_record` — kaynagin ham cevabi, `unique(source, source_id)`, asla silinmez.
 *      `content_hash` degismediyse kanonik yeniden uretimi atlanir.
 *   2. `event` — dedup_key ile tekillestirilmis kanonik kayit.
 */

/** Venue fuzzy eslesmesinin kabul esigi (docs §1.1 kural 2). */
const VENUE_SIMILARITY_MIN = 0.85;
/** Ayni ada sahip iki venue'nun ayni yer sayilmasi icin azami mesafe. */
const VENUE_DISTANCE_METERS = 500;

export interface IngestResult {
  seen: number;
  unchanged: number;
  eventsInserted: number;
  eventsUpdated: number;
  artistsReviewed: number;
  /** Iptal edilmisken geri gelen ve durumu duzeltilen etkinlik sayisi. */
  statusRestored: number;
  /** Cozumlenemeyen sanatcilar (ag hatasi/cooldown). Review kuyrugundan ayri. */
  artistsFailed: Array<{ name: string; reason: string }>;
  skipped: Array<{ sourceId: string; reason: string }>;
}

/**
 * Iki koordinat arasi mesafe (metre). Haversine — 500 m esigi icin duz
 * Oklid yaklasimindan daha guvenli, cunku enlem farki boylam olceginI bozar.
 */
function distanceMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const EARTH_RADIUS_M = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLng = (bLng - aLng) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

async function resolveVenue(
  q: typeof sql,
  metroAreaId: string,
  venue: RawEvent['venue'],
): Promise<string> {
  const exact = await q<{ id: string }>(
    'SELECT id FROM venue WHERE metro_area_id = $1 AND name_norm = norm_name($2) LIMIT 1',
    [metroAreaId, venue.name],
  );
  if (exact[0]) return exact[0].id;

  const fuzzy = await q<{ id: string; lat: number | null; lng: number | null; sim: number }>(
    `SELECT id, lat, lng, similarity(name_norm, norm_name($2)) AS sim
       FROM venue
      WHERE metro_area_id = $1 AND name_norm % norm_name($2)
      ORDER BY sim DESC
      LIMIT 3`,
    [metroAreaId, venue.name],
  );
  for (const candidate of fuzzy) {
    if (candidate.sim < VENUE_SIMILARITY_MIN) continue;
    const bothHaveCoords =
      venue.lat !== undefined &&
      venue.lng !== undefined &&
      candidate.lat !== null &&
      candidate.lng !== null;
    // Koordinat yoksa isim benzerligi tek basina yeter; varsa mesafe de tutmali.
    if (!bothHaveCoords) return candidate.id;
    if (
      distanceMeters(venue.lat!, venue.lng!, candidate.lat!, candidate.lng!) <=
      VENUE_DISTANCE_METERS
    ) {
      return candidate.id;
    }
  }

  const inserted = await q<{ id: string }>(
    `INSERT INTO venue (name, lat, lng, city, state, metro_area_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [venue.name, venue.lat ?? null, venue.lng ?? null, venue.city ?? null, venue.state ?? null, metroAreaId],
  );
  if (!inserted[0]) throw new Error(`venue insert basarisiz: ${venue.name}`);
  return inserted[0].id;
}

/**
 * docs §1.1: sha1(norm(venue) | venue-lokal TARIH | norm(headliner)).
 * Saat kasitli olarak dislanir — kaynaklar kapi/baslama saatinde 1-2 saat oynuyor.
 */
async function dedupKey(
  q: typeof sql,
  venueName: string,
  startsAt: string,
  headliner: string,
): Promise<string> {
  const row = await q<{ v: string; h: string; d: string }>(
    'SELECT norm_name($1) AS v, norm_name($2) AS h, ($3::timestamptz)::date::text AS d',
    [venueName, headliner, startsAt],
  );
  const parts = row[0];
  if (!parts) throw new Error('dedup_key hesaplanamadi');
  return createHash('sha1').update(`${parts.v}|${parts.d}|${parts.h}`).digest('hex');
}

/** Kaynak basina tek URL: ayni kaynaktan gelen eski link yenisiyle degisir. */
function mergeTicketUrls(existing: RawTicketUrl[], incoming: RawTicketUrl[]): RawTicketUrl[] {
  const bySource = new Map(existing.map((t) => [t.source, t]));
  for (const url of incoming) bySource.set(url.source, url);
  return [...bySource.values()];
}

export async function ingestEvents(
  events: readonly RawEvent[],
  metroAreaId: string,
): Promise<IngestResult> {
  const result: IngestResult = {
    seen: events.length,
    unchanged: 0,
    eventsInserted: 0,
    eventsUpdated: 0,
    artistsReviewed: 0,
    statusRestored: 0,
    artistsFailed: [],
    skipped: [],
  };

  for (const raw of events) {
    const contentHash = createHash('sha1').update(JSON.stringify(raw.payload)).digest('hex');
    const known = await sqlOne<{ content_hash: string; event_id: string | null }>(
      'SELECT content_hash, event_id FROM event_source_record WHERE source = $1 AND source_id = $2',
      [raw.source, raw.sourceId],
    );
    if (known && known.content_hash === contentHash && known.event_id) {
      // Icerik degismedi ama etkinligi BU koşuda gorduk. Iki sey sart:
      //  1. `fetched_at` tazelenmeli — yoksa hic degismeyen etkinlik zamanla
      //     "gorulmemis" sayilir ve markStaleCancelled onu iptal eder.
      //  2. Kanonik durum `raw.status`'a geri cekilmeli. Iki yokluk sonrasi
      //     iptal edilmis bir etkinlik ayni payload'la geri gelirse bu dala
      //     duser; durum duzeltilmezse sonsuza kadar 'cancelled' kalirdi.
      await sql(
        'UPDATE event_source_record SET fetched_at = now() WHERE source = $1 AND source_id = $2',
        [raw.source, raw.sourceId],
      );
      const restored = await sql<{ id: string }>(
        `UPDATE event SET status = $2, updated_at = now()
          WHERE id = $1 AND status <> $2
          RETURNING id`,
        [known.event_id, raw.status],
      );
      if (restored.length > 0) result.statusRestored += 1;
      result.unchanged += 1;
      continue;
    }

    const headliner =
      raw.artists.find((a) => a.billing === 'headliner') ?? raw.artists[0];
    if (!headliner) {
      result.skipped.push({ sourceId: raw.sourceId, reason: 'sanatci yok' });
      continue;
    }

    // Sanatci cozumlemesi transaction DISINDA: MusicBrainz cagrilari saniyeler
    // surebiliyor, DB kilidini o kadar tutmanin anlami yok.
    const resolutions: Array<{ artistId: string; billing: string; position: number }> = [];
    for (const [index, artist] of raw.artists.entries()) {
      // Tek sanatcinin cozumleme hatasi (ornegin MusicBrainz 503 cooldown'i)
      // tum ingest'i dusurmemeli — docs §4 kaynak-basina hata izolasyonu.
      // Lineup'ta bilinmeyen acilis gruplari sik sik MB aramasi tetikliyor.
      let resolution: ArtistResolution;
      try {
        resolution = await resolveArtist({
          name: artist.name,
          mbid: artist.mbid,
          externalIds: artist.externalId
            ? [{ source: raw.source, id: artist.externalId }]
            : undefined,
        });
      } catch (error) {
        result.artistsFailed.push({ name: artist.name, reason: (error as Error).message });
        continue;
      }
      if (isReview(resolution)) {
        result.artistsReviewed += 1;
        continue;
      }
      resolutions.push({
        artistId: resolution.artistId,
        billing: artist.billing ?? (index === 0 ? 'headliner' : 'support'),
        position: artist.position ?? index,
      });
    }
    // Headliner cozumlenemediyse etkinligi YAZMA: dedup_key headliner adina
    // dayaniyor ve eksik lineup'la yazilan etkinlik sessizce yanlis olur.
    const headlinerResolved = resolutions.some((r) => r.billing === 'headliner');
    if (resolutions.length === 0 || !headlinerResolved) {
      result.skipped.push({
        sourceId: raw.sourceId,
        reason: resolutions.length === 0 ? 'hicbir sanatci cozumlenemedi' : 'headliner cozumlenemedi',
      });
      continue;
    }

    await tx(async (q) => {
      const venueId = await resolveVenue(q, metroAreaId, raw.venue);
      const key = await dedupKey(q, raw.venue.name, raw.startsAt, headliner.name);

      const existing = await q<{ id: string; ticket_urls: RawTicketUrl[] }>(
        'SELECT id, ticket_urls FROM event WHERE dedup_key = $1',
        [key],
      );
      let eventId: string;
      if (existing[0]) {
        eventId = existing[0].id;
        await q(
          `UPDATE event
              SET title = COALESCE($2, title),
                  starts_at = $3,
                  ends_at = $4,
                  status = $5,
                  ticket_urls = $6,
                  updated_at = now()
            WHERE id = $1`,
          [
            eventId,
            raw.title ?? null,
            raw.startsAt,
            raw.endsAt ?? null,
            raw.status,
            JSON.stringify(mergeTicketUrls(existing[0].ticket_urls, raw.ticketUrls)),
          ],
        );
        result.eventsUpdated += 1;
      } else {
        const inserted = await q<{ id: string }>(
          `INSERT INTO event (dedup_key, venue_id, metro_area_id, title, starts_at, ends_at, ticket_urls, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            key,
            venueId,
            metroAreaId,
            raw.title ?? null,
            raw.startsAt,
            raw.endsAt ?? null,
            JSON.stringify(raw.ticketUrls),
            raw.status,
          ],
        );
        if (!inserted[0]) throw new Error(`event insert basarisiz: ${raw.sourceId}`);
        eventId = inserted[0].id;
        result.eventsInserted += 1;
      }

      for (const link of resolutions) {
        await q(
          `INSERT INTO event_artist (event_id, artist_id, billing, position)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (event_id, artist_id)
           DO UPDATE SET billing = EXCLUDED.billing, position = EXCLUDED.position`,
          [eventId, link.artistId, link.billing, link.position],
        );
      }

      await q(
        `INSERT INTO event_source_record (source, source_id, event_id, payload, content_hash)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source, source_id)
         DO UPDATE SET event_id = EXCLUDED.event_id,
                       payload = EXCLUDED.payload,
                       content_hash = EXCLUDED.content_hash,
                       fetched_at = now()`,
        [raw.source, raw.sourceId, eventId, JSON.stringify(raw.payload), contentHash],
      );
    });
  }

  return result;
}

/**
 * Cekim penceresi icinde olup bu koşuda gelmeyen etkinlikleri iptal isaretler (docs §4).
 *
 * Uc kapsam sinirlamasi — hepsi destructive oldugu icin zorunlu parametre:
 *
 *  - `windowEnd`: yalnizca GERCEKTEN sorgulanan tarih araligi taranir. Aksi halde
 *    pencerenin otesindeki (ornegin faz0'in 180 gunluk ingest'inden gelen 91-180.
 *    gun) etkinlikler "gelmedi, demek iptal" sanilir — cron 90 gun cektigi icin
 *    onlari hic gormez.
 *  - `source`: aday etkinligin BU kaynakta bir kaydi olmali. Ticketmaster'in
 *    eksiksiz bos snapshot'i, yalnizca SeatGeek'te var olan bir etkinligi
 *    iptal edemez — o kaynak hakkinda hicbir sey ogrenmedik.
 *  - `staleBefore`: cagiran taraf bunu onceki EKSIKSIZ koşunun zamani olarak verir,
 *    boylece tek yokluk yetmez (bkz. `refreshMetro`).
 *
 * Ayrica BASKA bir kaynak etkinligi `staleBefore`'dan sonra gordüyse iptal
 * edilmez: etkinlik hâlâ var, sadece bu kaynakta gorunmuyor.
 */
export async function markStaleCancelled(
  metroAreaId: string,
  source: SourceId,
  staleBefore: Date,
  windowEnd: Date,
): Promise<number> {
  const rows = await sql<{ id: string }>(
    `UPDATE event e
        SET status = 'cancelled', updated_at = now()
      WHERE e.metro_area_id = $1
        AND e.starts_at > now()
        AND e.starts_at < $4
        AND e.status = 'confirmed'
        AND EXISTS (
          SELECT 1 FROM event_source_record r
           WHERE r.event_id = e.id AND r.source = $2
        )
        AND NOT EXISTS (
          SELECT 1 FROM event_source_record r
           WHERE r.event_id = e.id AND r.fetched_at >= $3
        )
      RETURNING e.id`,
    [metroAreaId, source, staleBefore.toISOString(), windowEnd.toISOString()],
  );
  return rows.length;
}
