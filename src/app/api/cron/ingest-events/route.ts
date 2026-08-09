import { NextResponse } from 'next/server';
import { assertCron } from '@/lib/cron';
import { sql } from '@/lib/db/client';
import {
  recordMetroFailure,
  refreshMetro,
  type MetroRef,
  type MetroRefreshResult,
} from '@/lib/pipeline';
import { ticketmaster } from '@/lib/sources/ticketmaster';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Aktif metrolar icin etkinlik yenileme (vercel.json: 6 saatte bir).
 *
 * Faz 1'de metro-first: aktif metro sayisi az oldugu icin DMA sorgusu tek
 * koşuda bitiyor. Aktif metro > 5 olunca bu route Inngest'e tasinacak
 * (docs/05 §5.3 karar esigi) — o zamana kadar burada durmasi dogru.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    assertCron(request);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }

  if (!ticketmaster.isConfigured()) {
    return NextResponse.json({ error: 'TICKETMASTER_API_KEY is not set' }, { status: 503 });
  }

  const metros = await sql<MetroRef>(
    "SELECT id, slug, source_id FROM metro_area WHERE active AND source = 'ticketmaster_dma'",
  );

  const startedAt = new Date();
  const report: Array<MetroRefreshResult | { metro: string; error: string }> = [];

  for (const metro of metros) {
    try {
      report.push(await refreshMetro(ticketmaster, metro, startedAt));
    } catch (error) {
      const message = (error as Error).message;
      await recordMetroFailure(ticketmaster.id, metro.slug, message);
      report.push({ metro: metro.slug, error: message });
    }
  }

  return NextResponse.json({ ranAt: startedAt.toISOString(), metros: report });
}
