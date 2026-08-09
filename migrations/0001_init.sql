-- concertio 0001_init
-- Kaynak: docs/05-architecture.md §1. Sema oradaki DDL ile birebir ayni tutulur;
-- degistirirken iki tarafi birlikte guncelle.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Normalizasyon DB'de de tekrarlanabilir olsun diye IMMUTABLE fonksiyon.
-- unaccent() normalde STABLE oldugu icin generated column'da kullanilamaz;
-- sema-qualified cagri + IMMUTABLE wrapper bu yuzden zorunlu.
CREATE OR REPLACE FUNCTION norm_name(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT trim(both ' ' FROM
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(public.unaccent('public.unaccent'::regdictionary, t)), '^the\s+', ''),
        '\s*&\s*', ' and ', 'g'),
      '[^a-z0-9 ]', '', 'g'))
$$;

CREATE TABLE IF NOT EXISTS metro_area (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source      text NOT NULL,
  source_id   text NOT NULL,
  name        text NOT NULL,
  state       text,
  country     text NOT NULL DEFAULT 'US',
  lat         double precision,
  lng         double precision,
  slug        text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT false,
  UNIQUE (source, source_id)
);

CREATE TABLE IF NOT EXISTS venue (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          text NOT NULL,
  name_norm     text GENERATED ALWAYS AS (norm_name(name)) STORED,
  lat           double precision,
  lng           double precision,
  city          text,
  state         text,
  metro_area_id uuid REFERENCES metro_area(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS venue_name_trgm ON venue USING gin (name_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS venue_metro ON venue (metro_area_id);

CREATE TABLE IF NOT EXISTS artist (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        text NOT NULL,
  name_norm   text GENERATED ALWAYS AS (norm_name(name)) STORED,
  mbid        uuid UNIQUE,
  listeners_global bigint,
  spotify_popularity smallint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artist_name_trgm ON artist USING gin (name_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS artist_name_norm ON artist (name_norm);

CREATE TABLE IF NOT EXISTS artist_external_id (
  artist_id   uuid NOT NULL REFERENCES artist(id) ON DELETE CASCADE,
  source      text NOT NULL,
  external_id text NOT NULL,
  confidence  real NOT NULL DEFAULT 1.0,
  verified_via text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, external_id),
  UNIQUE (artist_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS aei_artist ON artist_external_id (artist_id);

CREATE TABLE IF NOT EXISTS artist_alias (
  id         bigserial PRIMARY KEY,
  artist_id  uuid NOT NULL REFERENCES artist(id) ON DELETE CASCADE,
  alias      text NOT NULL,
  alias_norm text GENERATED ALWAYS AS (norm_name(alias)) STORED,
  kind       text NOT NULL DEFAULT 'observed',
  UNIQUE (artist_id, alias_norm)
);
CREATE INDEX IF NOT EXISTS alias_norm_trgm ON artist_alias USING gin (alias_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS alias_norm_btree ON artist_alias (alias_norm);

CREATE TABLE IF NOT EXISTS event_source_record (
  id           bigserial PRIMARY KEY,
  source       text NOT NULL,
  source_id    text NOT NULL,
  event_id     uuid,
  payload      jsonb NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS esr_event ON event_source_record (event_id);

CREATE TABLE IF NOT EXISTS event (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  dedup_key     text NOT NULL,
  venue_id      uuid NOT NULL REFERENCES venue(id),
  metro_area_id uuid NOT NULL REFERENCES metro_area(id),
  title         text,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  ticket_urls   jsonb NOT NULL DEFAULT '[]',
  status        text NOT NULL DEFAULT 'confirmed',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dedup_key)
);
CREATE INDEX IF NOT EXISTS event_metro_starts ON event (metro_area_id, starts_at);
CREATE INDEX IF NOT EXISTS event_starts ON event (starts_at);

CREATE TABLE IF NOT EXISTS event_artist (
  event_id  uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  artist_id uuid NOT NULL REFERENCES artist(id),
  billing   text NOT NULL DEFAULT 'support',
  position  smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, artist_id)
);
CREATE INDEX IF NOT EXISTS ea_artist_event ON event_artist (artist_id, event_id);

CREATE TABLE IF NOT EXISTS app_user (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  lastfm_user   text UNIQUE,
  spotify_id    text UNIQUE,
  email         text UNIQUE,
  home_metro_id uuid REFERENCES metro_area(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_taste (
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  artist_id   uuid NOT NULL REFERENCES artist(id),
  score       real NOT NULL,
  sources     text[] NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, artist_id)
);
CREATE INDEX IF NOT EXISTS ut_user_score ON user_taste (user_id, score DESC);
CREATE INDEX IF NOT EXISTS ut_artist ON user_taste (artist_id);

CREATE TABLE IF NOT EXISTS ingest_watermark (
  source       text NOT NULL,
  scope        text NOT NULL,
  cursor       jsonb NOT NULL DEFAULT '{}',
  last_success timestamptz,
  last_error   text,
  error_count  int NOT NULL DEFAULT 0,
  PRIMARY KEY (source, scope)
);

CREATE TABLE IF NOT EXISTS source_config (
  source              text PRIMARY KEY,
  requests_per_second real NOT NULL,
  daily_quota         int,
  throttle_ms         int NOT NULL DEFAULT 0,
  enabled             boolean NOT NULL DEFAULT true,
  notes               text
);

CREATE TABLE IF NOT EXISTS match_review_queue (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  left_ref    jsonb NOT NULL,
  candidates  jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  resolved_by text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS mrq_pending ON match_review_queue (status) WHERE status = 'pending';

-- Bildirim K-8 ile kapsam disi (docs/07). Tablo ileride geri gelirse sema
-- degismesin diye burada duruyor ama hicbir kod yazmiyor.
CREATE TABLE IF NOT EXISTS notification (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  event_id  uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  artist_id uuid NOT NULL REFERENCES artist(id),
  channel   text NOT NULL DEFAULT 'email',
  sent_at   timestamptz,
  UNIQUE (user_id, event_id, artist_id, channel)
);

-- Baslangic konfigleri (docs/05 §5.1). Rate limitler kod sabiti degil, bu tablodan okunur.
INSERT INTO source_config (source, requests_per_second, daily_quota, throttle_ms, enabled, notes) VALUES
  ('ticketmaster', 4,   4500, 0,    true,  'Dogrulandi: 5000/gun, 5 rps. 4 rps marj birakiyor.'),
  ('lastfm',       2,   NULL, 0,    true,  'Resmi sayisal limit yok; muhafazakar 2 rps.'),
  ('musicbrainz',  1,   NULL, 1000, true,  '1 istek/sn/IP zorunlu + anlamli User-Agent.'),
  ('seatgeek',     2,   NULL, 0,    false, 'Faz 1. client_id gerekiyor.'),
  ('spotify',      2,   NULL, 0,    false, 'Faz 1, dev mode 5 allowlist kullanici.'),
  ('songkick',     1,   NULL, 1000, false, 'K-2: lisans + ToS 4.10 muafiyeti olmadan ASLA acilmaz.')
ON CONFLICT (source) DO NOTHING;

-- Faz 0 hedefi: SF Bay Area. Ticketmaster DMA 382 = San Francisco - Oakland - San Jose.
INSERT INTO metro_area (source, source_id, name, state, country, lat, lng, slug, active) VALUES
  ('ticketmaster_dma', '382', 'SF Bay Area', 'CA', 'US', 37.7749, -122.4194, 'sf-bay-area', true)
ON CONFLICT (source, source_id) DO NOTHING;
