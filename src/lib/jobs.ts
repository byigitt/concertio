import { sql, sqlOne } from '@/lib/db/client';
import type { RefreshCursor } from '@/lib/refresh-user';

/**
 * Is kuyrugu. `pnpm faz0` yerine site uzerinden yenileme talebi alinir.
 *
 * Kritik kararlar:
 *  - **Atomik claim.** `FOR UPDATE SKIP LOCKED` ile tek satir kilitlenir; iki
 *    worker ayni isi kapamaz. MusicBrainz'in 1 istek/sn limiti paralel koşuyu
 *    zaten yasakliyor, o yuzden worker tek tutuluyor.
 *  - **Stale claim geri alinir.** Koşu ortasinda olen lambda isi 'running'da
 *    asili birakir; `heartbeat_at` eskiyince is tekrar alinabilir.
 *  - **Tekil aktif is.** `ingest_job_one_active` unique index'i ayni
 *    kullanici+metro icin ikinci aktif isi engelliyor; `enqueueJob` mevcudu doner.
 *  - **Rate cap.** Auth yok, yani herkes is acabilir. Kullanici basina cooldown
 *    ve global kuyruk siniri, ucuncu taraf kotalarini (Last.fm/TM/MusicBrainz) korur.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

/** Heartbeat bundan eskiyse koşu olmus sayilir, is geri alinir. */
const STALE_AFTER_MS = 3 * 60_000;
/** Ayni kullanici bu sure icinde tekrar is acamaz. */
export const USER_COOLDOWN_MS = 30 * 60_000;
/** Kuyrukta bekleyen azami is; ustunde yeni talep reddedilir. */
const MAX_QUEUE_DEPTH = 20;
/** Bir is kac kez denenir; ustunde 'failed'. */
export const MAX_ATTEMPTS = 3;

export interface Job {
  id: string;
  lastfmUser: string;
  metroSlug: string;
  metroName: string;
  status: JobStatus;
  cursor: RefreshCursor;
  result: RefreshCursor | null;
  attempts: number;
  lastError: string | null;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

interface JobRow {
  id: string;
  lastfm_user: string;
  metro_slug: string;
  metro_name: string;
  status: JobStatus;
  cursor: RefreshCursor;
  result: RefreshCursor | null;
  attempts: number;
  last_error: string | null;
  requested_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/**
 * `cursor.worklist` snapshot'i buyuk (60 sanatci) ve UI'da hic gerekmiyor;
 * listeleme sorgularinda tasimamak icin cursor'dan cikariliyor, sayaclar kaliyor.
 */
const CURSOR_WITHOUT_WORKLIST = "(j.cursor - 'worklist')";

const SELECT_JOB = `
  SELECT j.id, j.lastfm_user, m.slug AS metro_slug, m.name AS metro_name, j.status,
         ${CURSOR_WITHOUT_WORKLIST} AS cursor, (j.result - 'worklist') AS result,
         j.attempts, j.last_error,
         j.requested_at, j.started_at, j.finished_at
    FROM ingest_job j
    JOIN metro_area m ON m.id = j.metro_area_id
`;

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    lastfmUser: row.lastfm_user,
    metroSlug: row.metro_slug,
    metroName: row.metro_name,
    status: row.status,
    cursor: row.cursor ?? {},
    result: row.result,
    attempts: row.attempts,
    lastError: row.last_error,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export type EnqueueOutcome =
  | { ok: true; job: Job; created: boolean }
  | { ok: false; reason: string };

export async function enqueueJob(lastfmUser: string, metroSlug: string): Promise<EnqueueOutcome> {
  const handle = lastfmUser.trim();
  if (handle.length < 2) return { ok: false, reason: 'username too short' };

  const metro = await sqlOne<{ id: string }>(
    'SELECT id FROM metro_area WHERE slug = $1 AND active',
    [metroSlug],
  );
  if (!metro) return { ok: false, reason: `no active area: ${metroSlug}` };

  // Ayni kullanici+metro icin aktif is varsa yeni is ACMA, mevcudu don.
  const active = await sqlOne<JobRow>(
    `${SELECT_JOB} WHERE lower(j.lastfm_user) = lower($1) AND j.metro_area_id = $2
        AND j.status IN ('queued','running')`,
    [handle, metro.id],
  );
  if (active) return { ok: true, job: toJob(active), created: false };

  const depth = await sqlOne<{ n: number }>(
    "SELECT count(*)::int AS n FROM ingest_job WHERE status IN ('queued','running')",
  );
  if ((depth?.n ?? 0) >= MAX_QUEUE_DEPTH) {
    return { ok: false, reason: 'queue full, try again later' };
  }

  const recent = await sqlOne<{ id: string }>(
    `SELECT id FROM ingest_job
      WHERE lower(lastfm_user) = lower($1)
        AND requested_at > now() - make_interval(secs => $2)
      ORDER BY requested_at DESC LIMIT 1`,
    [handle, USER_COOLDOWN_MS / 1000],
  );
  if (recent) {
    return {
      ok: false,
      reason: `refreshed recently, wait ${USER_COOLDOWN_MS / 60_000} min`,
    };
  }

  const inserted = await sqlOne<{ id: string }>(
    'INSERT INTO ingest_job (lastfm_user, metro_area_id) VALUES ($1, $2) RETURNING id',
    [handle, metro.id],
  );
  if (!inserted) return { ok: false, reason: 'insert failed' };
  const job = await jobById(inserted.id);
  if (!job) return { ok: false, reason: 'job vanished after insert' };
  return { ok: true, job, created: true };
}

export async function jobById(id: string): Promise<Job | undefined> {
  const row = await sqlOne<JobRow>(`${SELECT_JOB} WHERE j.id = $1`, [id]);
  return row ? toJob(row) : undefined;
}

/** Bir kullanicinin isleri, yenisi ustte. */
export async function jobsForUser(lastfmUser: string, limit = 10): Promise<Job[]> {
  const rows = await sql<JobRow>(
    `${SELECT_JOB} WHERE lower(j.lastfm_user) = lower($1)
      ORDER BY j.requested_at DESC LIMIT $2`,
    [lastfmUser.trim(), limit],
  );
  return rows.map(toJob);
}

/** Kuyruk goruntusu: aktif isler once, sonra son bitenler. */
export async function recentJobs(limit = 20): Promise<Job[]> {
  const rows = await sql<JobRow>(
    `${SELECT_JOB}
      ORDER BY (j.status IN ('queued','running')) DESC, j.requested_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map(toJob);
}

/** Worker'in isleyecegi cursor — `worklist` DAHIL (claim sonrasi tam okuma). */
export async function fullCursor(id: string): Promise<RefreshCursor> {
  const row = await sqlOne<{ cursor: RefreshCursor }>(
    'SELECT cursor FROM ingest_job WHERE id = $1',
    [id],
  );
  return row?.cursor ?? {};
}

/**
 * Bir isi atomik olarak kapar. Sirasi:
 *   1. 'queued' isler (en eski once),
 *   2. heartbeat'i eskimis 'running' isler (olen lambda).
 * `SKIP LOCKED` sayesinde ayni anda calisan ikinci worker bos doner.
 */
export interface ClaimedJob {
  job: Job;
  /** Bu kiraya ait jeton. Worker'in her yazmasi bunu tasimak ZORUNDA. */
  leaseToken: string;
}

export async function claimNextJob(): Promise<ClaimedJob | undefined> {
  const claimed = await sqlOne<{ id: string; lease_token: string }>(
    `WITH candidate AS (
       SELECT id FROM ingest_job
        WHERE status = 'queued'
           OR (status = 'running' AND heartbeat_at < now() - make_interval(secs => $1))
        ORDER BY requested_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE ingest_job j
        SET status = 'running',
            attempts = j.attempts + 1,
            started_at = COALESCE(j.started_at, now()),
            heartbeat_at = now(),
            lease_token = uuid_generate_v4()
       FROM candidate c
      WHERE j.id = c.id
      RETURNING j.id, j.lease_token`,
    [STALE_AFTER_MS / 1000],
  );
  if (!claimed) return undefined;
  const job = await jobById(claimed.id);
  if (!job) return undefined;
  return { job, leaseToken: claimed.lease_token };
}

/**
 * Ilerleme + heartbeat. Koşu boyunca her sanatcidan sonra cagrilir.
 * `false` donerse KIRA KAYBEDILMIS: baska bir worker isi devraldi, cagiran
 * taraf derhal durmali — yoksa devralanin ilerlemesini ezer.
 */
export async function saveProgress(
  id: string,
  leaseToken: string,
  cursor: RefreshCursor,
): Promise<boolean> {
  const rows = await sql<{ id: string }>(
    `UPDATE ingest_job SET cursor = $3, heartbeat_at = now()
      WHERE id = $1 AND lease_token = $2 AND status = 'running'
      RETURNING id`,
    [id, leaseToken, JSON.stringify(cursor)],
  );
  return rows.length === 1;
}

/**
 * Zaman butcesi dolduysa isi kuyruga geri koyar. `attempts` GERI ALINIR:
 * is basarisiz olmadi, sadece bolundu — yoksa uzun bir is 3 kirada
 * MAX_ATTEMPTS'e carpip haksizca 'failed' olurdu.
 */
export async function releaseJob(
  id: string,
  leaseToken: string,
  cursor: RefreshCursor,
): Promise<boolean> {
  const rows = await sql<{ id: string }>(
    `UPDATE ingest_job
        SET status = 'queued', cursor = $3, heartbeat_at = now(),
            attempts = GREATEST(attempts - 1, 0), lease_token = NULL
      WHERE id = $1 AND lease_token = $2 AND status = 'running'
      RETURNING id`,
    [id, leaseToken, JSON.stringify(cursor)],
  );
  return rows.length === 1;
}

export async function finishJob(
  id: string,
  leaseToken: string,
  result: RefreshCursor,
): Promise<boolean> {
  // `worklist` sonuca yazilmaz: bitmis iste degeri yok, satiri sisirir.
  const { worklist: _worklist, ...summary } = result;
  const rows = await sql<{ id: string }>(
    `UPDATE ingest_job
        SET status = 'done', cursor = $3, result = $3, finished_at = now(),
            last_error = NULL, lease_token = NULL
      WHERE id = $1 AND lease_token = $2 AND status = 'running'
      RETURNING id`,
    [id, leaseToken, JSON.stringify(summary)],
  );
  return rows.length === 1;
}

/**
 * Hata: deneme hakki kaldiysa kuyruga geri, yoksa 'failed'.
 * Sonsuz retry ucuncu taraf kotasini yakar, o yuzden sert sinir.
 */
export async function failJob(
  id: string,
  leaseToken: string,
  message: string,
): Promise<'requeued' | 'failed' | 'lost'> {
  const row = await sqlOne<{ attempts: number }>(
    'SELECT attempts FROM ingest_job WHERE id = $1 AND lease_token = $2',
    [id, leaseToken],
  );
  if (!row) return 'lost';
  if (row.attempts >= MAX_ATTEMPTS) {
    const rows = await sql<{ id: string }>(
      `UPDATE ingest_job SET status = 'failed', last_error = $3, finished_at = now(),
              lease_token = NULL
        WHERE id = $1 AND lease_token = $2 RETURNING id`,
      [id, leaseToken, message.slice(0, 500)],
    );
    return rows.length === 1 ? 'failed' : 'lost';
  }
  const rows = await sql<{ id: string }>(
    `UPDATE ingest_job SET status = 'queued', last_error = $3, lease_token = NULL
      WHERE id = $1 AND lease_token = $2 RETURNING id`,
    [id, leaseToken, message.slice(0, 500)],
  );
  return rows.length === 1 ? 'requeued' : 'lost';
}
