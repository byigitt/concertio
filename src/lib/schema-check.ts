import { sql } from '@/lib/db/client';

/**
 * Sema hazirlik kontrolu — TEK KAYNAK.
 *
 * Hem `/api/health` (yayindaki kurulumu teshis) hem `scripts/predeploy.ts`
 * (deploy kapisi) bunu cagirir. Iki ayri liste tutmak drift uretiyordu: kuyruk
 * eklendiginde kapi guncellendi ama health tablo adina bakmakla kaldi ve
 * `lease_token`'i olmayan eski bir tabloyu "hazir" gecirdi.
 */

/** Uygulamanin calismak icin ihtiyac duydugu tablolar. */
export const REQUIRED_TABLES = [
  'metro_area',
  'venue',
  'artist',
  'artist_external_id',
  'artist_alias',
  'event',
  'event_artist',
  'event_source_record',
  'app_user',
  'user_taste',
  'ingest_watermark',
  'source_config',
  'match_review_queue',
  'ingest_job',
] as const;

/** Sorgularda kullanilan SQL fonksiyonlari; migration atlanirsa eksik olur. */
export const REQUIRED_FUNCTIONS = ['norm_name', 'distance_m'] as const;

/** 0002 uygulanmazsa konum ozelligi sessizce coker. */
export const REQUIRED_HOME_COLUMNS = [
  'home_label',
  'home_lat',
  'home_lng',
  'home_city',
  'home_state',
  'home_country',
  'home_set_at',
] as const;

/** 0003 kismen uygulanmissa kuyruk coker; kolon adiyla kontrol sart. */
export const REQUIRED_JOB_COLUMNS = [
  'lease_token',
  'cursor',
  'heartbeat_at',
  'attempts',
  'status',
  'result',
] as const;

/** Ayni kullanici+metro icin ikinci aktif isi engelleyen partial unique index. */
export const REQUIRED_INDEXES = ['ingest_job_one_active', 'ingest_job_queue'] as const;

export interface SchemaReport {
  ready: boolean;
  missingTables: string[];
  missingFunctions: string[];
  missingHomeColumns: string[];
  missingJobColumns: string[];
  missingIndexes: string[];
  /** Fonksiyonlar var olmakla yetmez, dogru sonuc da vermeli. */
  functionProblems: string[];
}

async function presentNames(
  query: string,
  column: string,
  wanted: readonly string[],
): Promise<Set<string>> {
  const rows = await sql<Record<string, string>>(query, [[...wanted]]);
  return new Set(rows.map((r) => r[column]).filter((v): v is string => v !== undefined));
}

export async function checkSchema(): Promise<SchemaReport> {
  const tables = await presentNames(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    'table_name',
    REQUIRED_TABLES,
  );
  const functions = await presentNames(
    `SELECT routine_name FROM information_schema.routines
      WHERE routine_schema = 'public' AND routine_name = ANY($1)`,
    'routine_name',
    REQUIRED_FUNCTIONS,
  );
  const homeColumns = await presentNames(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'app_user' AND column_name = ANY($1)`,
    'column_name',
    REQUIRED_HOME_COLUMNS,
  );
  const jobColumns = await presentNames(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'ingest_job' AND column_name = ANY($1)`,
    'column_name',
    REQUIRED_JOB_COLUMNS,
  );
  const indexes = await presentNames(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'ingest_job' AND indexname = ANY($1)",
    'indexname',
    REQUIRED_INDEXES,
  );

  const functionProblems: string[] = [];
  if (functions.has('distance_m') && functions.has('norm_name')) {
    const probe = await sql<{ d: number | null; n: string | null }>(
      "SELECT distance_m(37.77, -122.41, 37.80, -122.27) AS d, norm_name('The Sigur Rós') AS n",
    );
    const row = probe[0];
    if (!row || row.d === null || row.d < 12_000 || row.d > 15_000) {
      functionProblems.push(`distance_m unexpected result: ${row?.d}`);
    }
    if (row?.n !== 'sigur ros') functionProblems.push(`norm_name unexpected result: ${row?.n}`);
  }

  const report: SchemaReport = {
    ready: false,
    missingTables: REQUIRED_TABLES.filter((t) => !tables.has(t)),
    missingFunctions: REQUIRED_FUNCTIONS.filter((f) => !functions.has(f)),
    missingHomeColumns: REQUIRED_HOME_COLUMNS.filter((c) => !homeColumns.has(c)),
    missingJobColumns: REQUIRED_JOB_COLUMNS.filter((c) => !jobColumns.has(c)),
    missingIndexes: REQUIRED_INDEXES.filter((i) => !indexes.has(i)),
    functionProblems,
  };
  report.ready =
    report.missingTables.length === 0 &&
    report.missingFunctions.length === 0 &&
    report.missingHomeColumns.length === 0 &&
    report.missingJobColumns.length === 0 &&
    report.missingIndexes.length === 0 &&
    report.functionProblems.length === 0;
  return report;
}

/** Kapi ve health icin insan okur satirlar. */
export function schemaProblems(report: SchemaReport): string[] {
  return [
    ...report.missingTables.map((t) => `missing table: ${t}`),
    ...report.missingFunctions.map((f) => `missing function: ${f}`),
    ...report.missingHomeColumns.map((c) => `missing column: app_user.${c}`),
    ...report.missingJobColumns.map((c) => `missing column: ingest_job.${c}`),
    ...report.missingIndexes.map((i) => `missing index: ${i}`),
    ...report.functionProblems,
  ];
}
