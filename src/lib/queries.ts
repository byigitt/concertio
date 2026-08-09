/**
 * Sayfalarin kullandigi okuma sorgulari. Ham SQL, ORM yok; tablo/kolon isimleri
 * migrations/0001_init.sql ile birebir. Yazma yolu (ingest/scoring) burada degil.
 */

import { sql, sqlOne } from '@/lib/db/client';
import type { Billing, RawTicketUrl, TasteSignal } from '@/lib/types';

export interface MetroRow {
  id: string;
  slug: string;
  name: string;
  state: string | null;
  country: string;
  active: boolean;
}

export interface MatchRow {
  eventId: string;
  title: string | null;
  startsAt: Date;
  ticketUrls: RawTicketUrl[];
  venueName: string;
  venueCity: string | null;
  artistName: string;
  billing: Billing;
  score: number;
  sources: TasteSignal[];
}

export interface UpcomingRow {
  eventId: string;
  title: string | null;
  startsAt: Date;
  ticketUrls: RawTicketUrl[];
  venueName: string;
  venueCity: string | null;
  headliners: string[];
}

interface MatchDbRow {
  event_id: string;
  title: string | null;
  starts_at: Date;
  ticket_urls: RawTicketUrl[];
  venue_name: string;
  venue_city: string | null;
  artist_name: string;
  billing: Billing;
  score: number;
  sources: TasteSignal[];
}

interface UpcomingDbRow {
  event_id: string;
  title: string | null;
  starts_at: Date;
  ticket_urls: RawTicketUrl[];
  venue_name: string;
  venue_city: string | null;
  headliners: string[];
}

/**
 * Kullanicinin taste profili ile metrodaki gelecek etkinliklerin kesisimi.
 * Bir etkinlikte kullanicinin birden fazla sanatcisi calabilir; DISTINCT ON ile
 * etkinlik basina en yuksek skorlu eslesme secilir, listede satir tekrari olmaz.
 */
export async function matchesForUser(lastfmUser: string, metroSlug: string): Promise<MatchRow[]> {
  const rows = await sql<MatchDbRow>(
    `SELECT * FROM (
       SELECT DISTINCT ON (e.id)
         e.id            AS event_id,
         e.title         AS title,
         e.starts_at     AS starts_at,
         e.ticket_urls   AS ticket_urls,
         v.name          AS venue_name,
         v.city          AS venue_city,
         a.name          AS artist_name,
         ea.billing      AS billing,
         ut.score        AS score,
         ut.sources      AS sources
       FROM app_user u
       JOIN user_taste   ut ON ut.user_id = u.id
       JOIN artist       a  ON a.id = ut.artist_id
       JOIN event_artist ea ON ea.artist_id = a.id
       JOIN event        e  ON e.id = ea.event_id
       JOIN venue        v  ON v.id = e.venue_id
       JOIN metro_area   m  ON m.id = e.metro_area_id
       WHERE lower(u.lastfm_user) = lower($1)
         AND m.slug = $2
         AND e.starts_at > now()
         AND e.status <> 'cancelled'
       ORDER BY e.id, ut.score DESC, ea.position ASC
     ) matched
     ORDER BY score DESC, starts_at ASC`,
    [lastfmUser, metroSlug],
  );

  return rows.map((r) => ({
    eventId: r.event_id,
    title: r.title,
    startsAt: r.starts_at,
    ticketUrls: r.ticket_urls,
    venueName: r.venue_name,
    venueCity: r.venue_city,
    artistName: r.artist_name,
    billing: r.billing,
    score: r.score,
    sources: r.sources,
  }));
}

/** Metrodaki gelecek etkinlikler; kisisellestirme yok, headliner adlariyla. */
export async function upcomingInMetro(metroSlug: string, limit: number): Promise<UpcomingRow[]> {
  const rows = await sql<UpcomingDbRow>(
    `SELECT
       e.id          AS event_id,
       e.title       AS title,
       e.starts_at   AS starts_at,
       e.ticket_urls AS ticket_urls,
       v.name        AS venue_name,
       v.city        AS venue_city,
       COALESCE(
         array_agg(a.name ORDER BY ea.position) FILTER (WHERE a.name IS NOT NULL),
         ARRAY[]::text[]
       ) AS headliners
     FROM event e
     JOIN venue      v  ON v.id = e.venue_id
     JOIN metro_area m  ON m.id = e.metro_area_id
     LEFT JOIN event_artist ea ON ea.event_id = e.id AND ea.billing = 'headliner'
     LEFT JOIN artist       a  ON a.id = ea.artist_id
     WHERE m.slug = $1
       AND e.starts_at > now()
       AND e.status <> 'cancelled'
     GROUP BY e.id, v.name, v.city
     ORDER BY e.starts_at ASC
     LIMIT $2`,
    [metroSlug, limit],
  );

  return rows.map((r) => ({
    eventId: r.event_id,
    title: r.title,
    startsAt: r.starts_at,
    ticketUrls: r.ticket_urls,
    venueName: r.venue_name,
    venueCity: r.venue_city,
    headliners: r.headliners,
  }));
}

export async function metroBySlug(slug: string): Promise<MetroRow | undefined> {
  return sqlOne<MetroRow>(
    `SELECT id, slug, name, state, country, active
     FROM metro_area
     WHERE slug = $1`,
    [slug],
  );
}

/** Yalnizca ingest'i acik metrolar; kapali metronun sayfasi bos cikar, listelemiyoruz. */
export async function listMetros(): Promise<MetroRow[]> {
  return sql<MetroRow>(
    `SELECT id, slug, name, state, country, active
     FROM metro_area
     WHERE active
     ORDER BY name ASC`,
  );
}
