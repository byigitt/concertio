#!/usr/bin/env tsx
/**
 * GERCEK deploy kapisi: migration'lari uygular, semayi dogrular, eksikse
 * SIFIRDAN FARKLI kodla cikar. `pnpm predeploy && vercel deploy --prod`
 * zincirinde ilk komut basarisiz olursa deploy HIC calismaz.
 *
 * `/api/health` bunun yerini tutmaz: o deploy'dan SONRA teshis eder,
 * kotu deploy'u engellemez.
 */
import { pool, sql } from '../src/lib/db/client.ts';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Uygulamanin calismak icin ihtiyac duydugu tablolar. */
const REQUIRED_TABLES = [
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
] as const;

const REQUIRED_FUNCTIONS = ['norm_name', 'distance_m'] as const;
/** 0002 uygulanmazsa konum ozelligi sessizce coker. */
const REQUIRED_HOME_COLUMNS = [
  'home_label',
  'home_lat',
  'home_lng',
  'home_city',
  'home_state',
  'home_country',
  'home_set_at',
] as const;

const problems: string[] = [];

function requireEnv(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL yok. `vercel env pull .env.production.local` calistir.');
    process.exit(1);
  }
  if (url.includes('localhost') && !process.argv.includes('--allow-local')) {
    console.error('DATABASE_URL localhost gosteriyor. Prod kapisi icin --allow-local ver.');
    process.exit(1);
  }
  return url;
}

async function applyMigrations(): Promise<void> {
  const dir = path.join(process.cwd(), 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    console.log(`migration -> ${file}`);
    await sql(await readFile(path.join(dir, file), 'utf8'));
  }
}

async function verifySchema(): Promise<void> {
  const tables = await sql<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [[...REQUIRED_TABLES]],
  );
  const found = new Set(tables.map((t) => t.table_name));
  for (const t of REQUIRED_TABLES) if (!found.has(t)) problems.push(`tablo eksik: ${t}`);

  const functions = await sql<{ routine_name: string }>(
    `SELECT routine_name FROM information_schema.routines
      WHERE routine_schema = 'public' AND routine_name = ANY($1)`,
    [[...REQUIRED_FUNCTIONS]],
  );
  const fns = new Set(functions.map((f) => f.routine_name));
  for (const f of REQUIRED_FUNCTIONS) if (!fns.has(f)) problems.push(`fonksiyon eksik: ${f}`);

  const columns = await sql<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'app_user' AND column_name = ANY($1)`,
    [[...REQUIRED_HOME_COLUMNS]],
  );
  const cols = new Set(columns.map((c) => c.column_name));
  for (const c of REQUIRED_HOME_COLUMNS) if (!cols.has(c)) problems.push(`kolon eksik: app_user.${c}`);

  // Fonksiyonlar yalnizca VAR olmakla yetmez, dogru sonuc da vermeli.
  const probe = await sql<{ d: number | null; n: string | null }>(
    "SELECT distance_m(37.77, -122.41, 37.80, -122.27) AS d, norm_name('The Sigur Rós') AS n",
  );
  const row = probe[0];
  if (!row || row.d === null || row.d < 12_000 || row.d > 15_000) {
    problems.push(`distance_m beklenmeyen sonuc: ${row?.d}`);
  }
  if (row?.n !== 'sigur ros') {
    problems.push(`norm_name beklenmeyen sonuc: ${row?.n}`);
  }

  const seeded = await sql<{ n: number }>('SELECT count(*)::int AS n FROM source_config');
  if ((seeded[0]?.n ?? 0) === 0) problems.push('source_config bos: rate limit konfigi yok');
}

requireEnv();
try {
  await applyMigrations();
  await verifySchema();
} catch (error) {
  problems.push(`kapi hatasi: ${(error as Error).message}`);
} finally {
  await pool().end();
}

if (problems.length > 0) {
  console.error('\nDEPLOY DURDURULDU:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nsema hazir; deploy edilebilir.');
