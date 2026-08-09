-- concertio 0002: kullanici ev konumu ve yakinlik (reach) filtresi
--
-- Amac: kullanici evini girdikten sonra konserleri "yurume mesafesi / toplu
-- tasima / ayni sehir / gun donusu / ayni ulke" seklinde filtreleyebilsin.
--
-- ONEMLI: mesafe DUZ HAT (great-circle) mesafesidir, yol/rota mesafesi degil.
-- Bu yuzden kademe isimleri bir rota iddiasi tasimaz; `walk` "2 km icinde,
-- yurunebilir olma ihtimali yuksek" demektir, "yurunebilir" garantisi degil.

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS home_label   text,
  ADD COLUMN IF NOT EXISTS home_lat     double precision,
  ADD COLUMN IF NOT EXISTS home_lng     double precision,
  ADD COLUMN IF NOT EXISTS home_city    text,
  ADD COLUMN IF NOT EXISTS home_state   text,
  ADD COLUMN IF NOT EXISTS home_country text,
  ADD COLUMN IF NOT EXISTS home_set_at  timestamptz;

-- Koordinat varsa ikisi birlikte olmali; yarim konum sessiz hatalara yol acar.
ALTER TABLE app_user
  DROP CONSTRAINT IF EXISTS app_user_home_coords_together;
ALTER TABLE app_user
  ADD CONSTRAINT app_user_home_coords_together
  CHECK ((home_lat IS NULL) = (home_lng IS NULL));

-- venue.country: "ayni ulke" filtresi icin. Mevcut satirlar metro_area'dan doldurulur.
ALTER TABLE venue ADD COLUMN IF NOT EXISTS country text;
UPDATE venue v
   SET country = m.country
  FROM metro_area m
 WHERE v.metro_area_id = m.id AND v.country IS NULL;

-- Haversine, metre. IMMUTABLE: generated column ve indeksli ifadelerde kullanilabilir.
-- earthdistance/PostGIS eklemek yerine bu yeterli: tek formul, ek bagimlilik yok.
CREATE OR REPLACE FUNCTION distance_m(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN lat1 IS NULL OR lng1 IS NULL OR lat2 IS NULL OR lng2 IS NULL THEN NULL
    ELSE 2 * 6371000 * asin(sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2) +
      cos(radians(lat1)) * cos(radians(lat2)) *
      power(sin(radians(lng2 - lng1) / 2), 2)
    ))
  END
$$;

-- Ev konumuna gore siralama/filtreleme venue koordinatlarini tarar.
CREATE INDEX IF NOT EXISTS venue_coords ON venue (lat, lng) WHERE lat IS NOT NULL;

-- Nominatim (OpenStreetMap) geocoder: adres -> koordinat.
-- 1 istek/sn ve anlamli User-Agent zorunlu (MusicBrainz ile ayni model).
INSERT INTO source_config (source, requests_per_second, daily_quota, throttle_ms, enabled, notes) VALUES
  ('nominatim', 1, NULL, 1000, true, 'OSM Nominatim: 1 istek/sn + User-Agent zorunlu, ticari kullanimda kendi sunucunu kur.')
ON CONFLICT (source) DO NOTHING;
