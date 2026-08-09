-- concertio 0003: kullanici taste/etkinlik yenilemesi icin is kuyrugu
--
-- Neden: `pnpm faz0 --user=X --metro=Y` elle CLI koşusuydu. Baska birinin
-- listesini uretmek icin makineye erisim gerekiyordu. Bu tablo ayni isi site
-- uzerinden kuyruga alinabilir hale getiriyor.
--
-- Tasarim notlari:
--  - Tek worker varsayimi: `claim` sorgusu `FOR UPDATE SKIP LOCKED` ile atomik.
--    Iki lambda ayni isi kapamaz. MusicBrainz 1 istek/sn limiti zaten paralel
--    koşuyu yasakliyor.
--  - Resumable: serverless zaman siniri (Vercel maxDuration 300 sn) bir koşuyu
--    kesebilir. `cursor` islenmis sanatci sayisini tutar, sonraki koşu oradan
--    devam eder. `attempts` sonsuz donguyu engeller.
--  - `heartbeat_at`: koşu ortasinda olen lambda isi 'running'da asili birakir.
--    Stale claim'i geri almak icin kullanilir (bkz. src/lib/jobs.ts).

CREATE TABLE IF NOT EXISTS ingest_job (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  lastfm_user   text NOT NULL,
  metro_area_id uuid NOT NULL REFERENCES metro_area(id),
  status        text NOT NULL DEFAULT 'queued',   -- 'queued'|'running'|'done'|'failed'
  -- Islenmis sanatci sayaci + ara sonuclar. Koşu bolununce buradan devam edilir.
  cursor        jsonb NOT NULL DEFAULT '{}',
  -- Bitmis isin ozeti: sinyal/sanatci/etkinlik/eslesme sayilari.
  result        jsonb,
  attempts      int NOT NULL DEFAULT 0,
  last_error    text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  heartbeat_at  timestamptz,
  finished_at   timestamptz,
  -- Kira jetonu: her claim yeni bir uuid uretir. Worker'in TUM yazmalari bu
  -- jetonu WHERE'de tasir. Neden: heartbeat tek basina yetmez — yavas bir dis
  -- cagride takilan worker A hala yasarken heartbeat eskiyip worker B isi
  -- devralabilir; sonra A kosulsuz yazip B'nin ilerlemesini eziyordu.
  -- Jeton eslesmezse A'nin UPDATE'i 0 satir etkiler ve A durur.
  lease_token   uuid,
  CONSTRAINT ingest_job_status_valid
    CHECK (status IN ('queued', 'running', 'done', 'failed'))
);

-- Tablo daha once olusmussa kolonu ekle: `CREATE TABLE IF NOT EXISTS` mevcut
-- tabloda no-op oldugu icin kolon ancak boyle geliyor (upgrade yolu).
ALTER TABLE ingest_job ADD COLUMN IF NOT EXISTS lease_token uuid;

-- Worker en eski kuyruktaki isi alir.
CREATE INDEX IF NOT EXISTS ingest_job_queue ON ingest_job (status, requested_at)
  WHERE status IN ('queued', 'running');

-- Kullanici bazli gecmis ve rate limit sorgulari.
CREATE INDEX IF NOT EXISTS ingest_job_user ON ingest_job (lower(lastfm_user), requested_at DESC);

-- Ayni kullanici+metro icin AYNI ANDA en fazla bir aktif is. Kuyruga iki kez
-- basmak yeni is acmaz, mevcut isi dondurur (bkz. enqueueJob).
CREATE UNIQUE INDEX IF NOT EXISTS ingest_job_one_active
  ON ingest_job (lower(lastfm_user), metro_area_id)
  WHERE status IN ('queued', 'running');
