#!/usr/bin/env tsx
/**
 * GERCEK deploy kapisi: migration'lari uygular, semayi dogrular, eksikse
 * SIFIRDAN FARKLI kodla cikar. `pnpm deploy:prod` = `deploy:gate && vercel deploy`
 * zincirinde ilk komut duserse deploy HIC calismaz.
 *
 * `/api/health` bunun yerini tutmaz: o deploy'dan SONRA teshis eder.
 * Ikisi de AYNI `checkSchema()` fonksiyonunu kullanir — liste tek yerde durur.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pool, sql } from '../src/lib/db/client.ts';
import { checkSchema, schemaProblems } from '../src/lib/schema-check.ts';

const problems: string[] = [];

function requireEnv(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL yok. `vercel env pull .env.production.local` calistir.');
    process.exit(1);
  }
  if (url.includes('localhost') && !process.argv.includes('--allow-local')) {
    console.error('DATABASE_URL localhost gosteriyor. Prod kapisi icin --allow-local ver.');
    process.exit(1);
  }
}

async function applyMigrations(): Promise<void> {
  const dir = path.join(process.cwd(), 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    console.log(`migration -> ${file}`);
    await sql(await readFile(path.join(dir, file), 'utf8'));
  }
}

requireEnv();
try {
  await applyMigrations();
  const report = await checkSchema();
  problems.push(...schemaProblems(report));

  const seeded = await sql<{ n: number }>('SELECT count(*)::int AS n FROM source_config');
  if ((seeded[0]?.n ?? 0) === 0) problems.push('source_config empty: no rate limit config');
} catch (error) {
  problems.push(`gate error: ${(error as Error).message}`);
} finally {
  await pool().end();
}

if (problems.length > 0) {
  console.error('\nDEPLOY STOPPED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nschema ready; safe to deploy.');
