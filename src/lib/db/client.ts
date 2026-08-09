import { Pool, type QueryResultRow } from 'pg';

/**
 * Tek havuz. Next.js dev'de HMR her modul yenilemesinde yeni havuz acmasin diye
 * globalThis'e tutturulur; Vercel'de her lambda kendi havuzunu acar.
 */
const globalForPool = globalThis as unknown as { concertioPool?: Pool };

export function pool(): Pool {
  if (!globalForPool.concertioPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set. copy .env.example to .env.local.');
    }
    globalForPool.concertioPool = new Pool({
      connectionString,
      max: 5,
      // Neon/Vercel arasinda idle baglantiyi uzun tutmanin anlami yok.
      idleTimeoutMillis: 10_000,
      ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: true },
    });
  }
  return globalForPool.concertioPool;
}

export async function sql<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pool().query<T>(text, params as unknown[]);
  return result.rows;
}

/** Tek satir bekleyen sorgular icin; 0 satirda undefined doner. */
export async function sqlOne<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  const rows = await sql<T>(text, params);
  return rows[0];
}

/**
 * Pipeline adimlari birbirini yarim birakmasin diye tek transaction.
 * Hata halinde rollback edip firlatiyor — cagiran katman kaynak bazli
 * hata izolasyonunu (ingest_watermark.error_count) kendi yonetir.
 */
export async function tx<T>(fn: (q: typeof sql) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const scoped = async <R extends QueryResultRow>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<R[]> => (await client.query<R>(text, params as unknown[])).rows;
    const out = await fn(scoped as typeof sql);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
