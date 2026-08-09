import { NextResponse } from 'next/server';
import { assertCron } from '@/lib/cron';
import { sql } from '@/lib/db/client';
import { resolveArtist } from '@/lib/matching';
import { scoreTaste } from '@/lib/scoring';
import { lastfm } from '@/lib/sources/lastfm';
import { isReview } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Kullanici basina gunluk yenilenen taste sayisi ust siniri (docs §5.2 butcesi). */
const MAX_ARTISTS_PER_USER = 60;

/**
 * Kullanici zevkini yeniler (vercel.json: gunde bir, 04:00 UTC).
 * Kullanici basina Last.fm cagrisi 6 civari; 2 rps limitinde 1000 kullanici ~50 dk,
 * yani bu route tek lambda'ya sigmayi ancak birkac yuz kullaniciya kadar surdurur.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    assertCron(request);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }

  if (!lastfm.isConfigured()) {
    return NextResponse.json({ error: 'LASTFM_API_KEY yok' }, { status: 503 });
  }

  const users = await sql<{ id: string; lastfm_user: string }>(
    'SELECT id, lastfm_user FROM app_user WHERE lastfm_user IS NOT NULL',
  );

  const report: Array<Record<string, unknown>> = [];
  for (const user of users) {
    try {
      const signals = await lastfm.fetchTaste(user.lastfm_user);
      const scored = scoreTaste(signals).slice(0, MAX_ARTISTS_PER_USER);
      let linked = 0;
      let reviewed = 0;
      for (const entry of scored) {
        const resolution = await resolveArtist({ name: entry.artistName, mbid: entry.mbid });
        if (isReview(resolution)) {
          reviewed += 1;
          continue;
        }
        await sql(
          `INSERT INTO user_taste (user_id, artist_id, score, sources, computed_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (user_id, artist_id)
           DO UPDATE SET score = EXCLUDED.score, sources = EXCLUDED.sources, computed_at = now()`,
          [user.id, resolution.artistId, entry.score, entry.sources],
        );
        linked += 1;
      }
      await sql(
        `INSERT INTO ingest_watermark (source, scope, last_success, error_count)
         VALUES ('lastfm', $1, now(), 0)
         ON CONFLICT (source, scope)
         DO UPDATE SET last_success = now(), error_count = 0, last_error = NULL`,
        [user.id],
      );
      report.push({ user: user.lastfm_user, signals: signals.length, linked, reviewed });
    } catch (error) {
      const message = (error as Error).message;
      await sql(
        `INSERT INTO ingest_watermark (source, scope, last_error, error_count)
         VALUES ('lastfm', $1, $2, 1)
         ON CONFLICT (source, scope)
         DO UPDATE SET last_error = $2, error_count = ingest_watermark.error_count + 1`,
        [user.id, message],
      );
      report.push({ user: user.lastfm_user, error: message });
    }
  }

  return NextResponse.json({ users: report });
}
