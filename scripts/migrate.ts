#!/usr/bin/env tsx
/**
 * Migration runner. Tek dosya, idempotent (her ifade IF NOT EXISTS / ON CONFLICT).
 * `--reset` semayi dusurup yeniden kurar — SADECE lokal gelistirme icin.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pool, sql } from '../src/lib/db/client.ts';

const reset = process.argv.includes('--reset');

async function main(): Promise<void> {
  if (reset) {
    if (!(process.env.DATABASE_URL ?? '').includes('localhost')) {
      throw new Error('--reset yalnizca localhost DATABASE_URL ile calisir.');
    }
    console.log('! semayi dusuruyorum (public)');
    await sql('DROP SCHEMA public CASCADE');
    await sql('CREATE SCHEMA public');
  }

  const dir = path.join(process.cwd(), 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const ddl = await readFile(path.join(dir, file), 'utf8');
    console.log(`-> ${file}`);
    await sql(ddl);
  }

  const [tables] = await sql<{ count: string }>(
    "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
  );
  const [configs] = await sql<{ count: string }>('SELECT count(*)::text AS count FROM source_config');
  console.log(`ok: ${tables?.count} tablo, ${configs?.count} source_config satiri`);
}

await main();
await pool().end();
