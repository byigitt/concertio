/**
 * Sayfalarin kullandigi okuma sorgulari. Ham SQL, ORM yok; tablo/kolon isimleri
 * migrations/0001_init.sql ile birebir. Yazma yolu (ingest/scoring) burada degil.
 */

import { sql, sqlOne } from '@/lib/db/client';
import { classifyReach, REACH_SELECT_SQL, reachWhereSql, type Reach } from '@/lib/reach';
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
  /** Ev konumu ayarliysa duz hat mesafesi (metre), yoksa null. */
  distanceMeters: number | null;
  /** Ev konumu ayarliysa en dar yakinlik kademesi, yoksa undefined. */
  reach?: Reach;
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
  distance_m: number | null;
  same_city: boolean;
  same_country: boolean;
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

export interface HomeLocation {
  label: string | null;
  lat: number | null;
  lng: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  setAt: Date | null;
}

export interface MatchQuery {
  lastfmUser: string;
  /** Verilmezse tum metrolar; `country`/`all` kademesinde metro sinirlamak anlamsiz. */
  metroSlug?: string;
  reach?: Reach;
  home?: HomeLocation;
}

export async function homeForUser(lastfmUser: string): Promise<HomeLocation | undefined> {
  const row = await sqlOne<{
    home_label: string | null;
    home_lat: number | null;
    home_lng: number | null;
    home_city: string | null;
    home_state: string | null;
    home_country: string | null;
    home_set_at: Date | null;
  }>(
    `SELECT home_label, home_lat, home_lng, home_city, home_state, home_country, home_set_at
       FROM app_user WHERE lower(lastfm_user) = lower($1)`,
    [lastfmUser],
  );
  if (!row) return undefined;
  return {
    label: row.home_label,
    lat: row.home_lat,
    lng: row.home_lng,
    city: row.home_city,
    state: row.home_state,
    country: row.home_country,
    setAt: row.home_set_at,
  };
}

/**
 * Kullanicinin taste profili ile gelecek etkinliklerin kesisimi.
 *
 * Bir etkinlikte kullanicinin birden fazla sanatcisi calabilir; DISTINCT ON ile
 * etkinlik basina en yuksek skorlu eslesme secilir, listede satir tekrari olmaz.
 *
 * Ev konumu verilmisse her satira duz hat mesafesi ve yakinlik kademesi eklenir;
 * `reach` verilmisse SQL tarafinda filtrelenir (bkz. `src/lib/reach.ts`).
 * Ev konumu yoksa `reach` yok sayilir — filtre uygulanacak referans nokta yok.
 */
export async function matchesForUser(query: MatchQuery): Promise<MatchRow[]> {
  const home = query.home;
  const hasHome = home?.lat !== null && home?.lat !== undefined && home.lng !== null;
  const reach = hasHome ? (query.reach ?? 'all') : 'all';
  const where = reachWhereSql(reach);

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
         ut.sources      AS sources,
         ${REACH_SELECT_SQL}
       FROM app_user u
       JOIN user_taste   ut ON ut.user_id = u.id
       JOIN artist       a  ON a.id = ut.artist_id
       JOIN event_artist ea ON ea.artist_id = a.id
       JOIN event        e  ON e.id = ea.event_id
       JOIN venue        v  ON v.id = e.venue_id
       JOIN metro_area   m  ON m.id = e.metro_area_id
       WHERE lower(u.lastfm_user) = lower($1)
         AND ($6::text IS NULL OR m.slug = $6)
         AND e.starts_at > now()
         AND e.status <> 'cancelled'
         ${where ? `AND (${where})` : ''}
       ORDER BY e.id, ut.score DESC, ea.position ASC
     ) matched
     ORDER BY score DESC, distance_m ASC NULLS LAST, starts_at ASC`,
    [
      query.lastfmUser,
      home?.lat ?? null,
      home?.lng ?? null,
      home?.city ?? null,
      home?.country ?? null,
      query.metroSlug ?? null,
    ],
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
    distanceMeters: r.distance_m,
    reach: hasHome ? classifyReach(r.distance_m, r.same_city, r.same_country) : undefined,
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
