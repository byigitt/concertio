import { NextResponse } from 'next/server';
import { checkSchema, schemaProblems } from '@/lib/schema-check';

export const dynamic = 'force-dynamic';

/**
 * Sema hazirlik kontrolu.
 *
 * Vercel build'i migration CALISTIRMAZ (bilerek: build paralel ve tekrarli
 * kosabilir, DB'ye erisimi de garanti degil). O yuzden deploy sirasi:
 *   1. `pnpm deploy:gate`      — semayi uygula + dogrula, eksikse exit 1
 *   2. `vercel deploy --prod`  — uygulamayi yayina al
 *   3. `GET /api/health`       — yayindaki kurulumu TEYIT et
 *
 * Kontrol listesi `src/lib/schema-check.ts`'te ve kapi ile PAYLASILIYOR;
 * iki ayri liste tutmak drift uretiyordu.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const report = await checkSchema();
    return NextResponse.json(
      {
        ready: report.ready,
        problems: schemaProblems(report),
        hint: report.ready ? undefined : 'run pnpm deploy:gate to apply migrations, then retry.',
      },
      { status: report.ready ? 200 : 503 },
    );
  } catch (error) {
    return NextResponse.json(
      { ready: false, error: (error as Error).message, hint: 'is DATABASE_URL reachable?' },
      { status: 503 },
    );
  }
}
