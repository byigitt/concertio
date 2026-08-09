import { NextResponse } from 'next/server';
import { sql } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

/**
 * Sema hazirlik kontrolu.
 *
 * Vercel build'i migration CALISTIRMAZ (bilerek: build paralel ve tekrarli
 * kosabilir, DB'ye erisimi de garanti degil). O yuzden deploy sirasi:
 *   1. `pnpm db:migrate:prod`  — Neon'a semayi uygula
 *   2. `vercel deploy --prod`  — uygulamayi yayina al
 *   3. `GET /api/health`       — semanin hazir oldugunu TEYIT et
 *
 * Bu endpoint eksik tabloyu opak bir 500 yerine adiyla soyler.
 */

/** Uygulamanin calismak icin ihtiyac duydugu tablolar. */
const REQUIRED_TABLES = [
  'metro_area',
  'venue',
  'artist',
  'artist_external_id',
  'event',
  'event_artist',
  'event_source_record',
  'app_user',
  'user_taste',
  'ingest_watermark',
  'source_config',
] as const;

/** Sorgularda kullanilan SQL fonksiyonlari; migration atlanirsa bunlar eksik olur. */
const REQUIRED_FUNCTIONS = ['norm_name', 'distance_m'] as const;

export async function GET(): Promise<NextResponse> {
  try {
    const tables = await sql<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [[...REQUIRED_TABLES]],
    );
    const functions = await sql<{ routine_name: string }>(
      `SELECT routine_name FROM information_schema.routines
        WHERE routine_schema = 'public' AND routine_name = ANY($1)`,
      [[...REQUIRED_FUNCTIONS]],
    );
    const homeColumns = await sql<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'app_user' AND column_name LIKE 'home\\_%'`,
    );

    const foundTables = new Set(tables.map((t) => t.table_name));
    const foundFunctions = new Set(functions.map((f) => f.routine_name));
    const missingTables = REQUIRED_TABLES.filter((t) => !foundTables.has(t));
    const missingFunctions = REQUIRED_FUNCTIONS.filter((f) => !foundFunctions.has(f));
    // 0002 uygulanmadiysa home_* kolonlari hic olmaz; konum ozelligi sessizce cokerdi.
    const locationReady = homeColumns.length >= 7;

    const ready = missingTables.length === 0 && missingFunctions.length === 0 && locationReady;
    return NextResponse.json(
      {
        ready,
        missingTables,
        missingFunctions,
        locationSchemaReady: locationReady,
        hint: ready ? undefined : 'run pnpm deploy:gate to apply migrations, then retry.',
      },
      { status: ready ? 200 : 503 },
    );
  } catch (error) {
    return NextResponse.json(
      { ready: false, error: (error as Error).message, hint: 'is DATABASE_URL reachable?' },
      { status: 503 },
    );
  }
}
