import { NextResponse } from 'next/server';
import { assertCron } from '@/lib/cron';
import {
  claimNextJob,
  failJob,
  finishJob,
  fullCursor,
  releaseJob,
  saveProgress,
} from '@/lib/jobs';
import { refreshUser } from '@/lib/refresh-user';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Kuyruk worker'i. Bir is kapar, zaman butcesi kadar isler, sonra ya bitirir
 * ya kuyruga geri koyar.
 *
 * Tek is/cagri: MusicBrainz 1 istek/sn limiti paralel koşuyu yasakliyor, o
 * yuzden burada dongu yok. Kuyrukta is kaldiysa cron sonraki turda alir; site
 * de gonderimden sonra bu rotayi bir kez tetikleyebilir.
 *
 * Zaman butcesi `maxDuration`'dan KISA: son yazmalar (finish/release) ve HTTP
 * cevabi icin pay birakiyoruz, yoksa lambda tam yazma aninda kesilir.
 * Env ile ayarlanabilir cunku plan basina `maxDuration` degisiyor (ve testte
 * kucuk butce vererek bolunme yolu zorlanabiliyor).
 */
const TIME_BUDGET_MS = Number(process.env.CONCERTIO_JOB_BUDGET_MS ?? 240_000);

export async function GET(request: Request): Promise<NextResponse> {
  try {
    assertCron(request);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }

  const claimed = await claimNextJob();
  if (!claimed) return NextResponse.json({ claimed: false });

  const { job, leaseToken } = claimed;
  // Cursor tam haliyle (worklist snapshot dahil) okunur; listeleme sorgulari
  // snapshot'i tasimadigi icin ayri bir okuma gerekiyor.
  const cursor = await fullCursor(job.id);

  try {
    let leaseLost = false;
    const outcome = await refreshUser({
      lastfmUser: job.lastfmUser,
      metroSlug: job.metroSlug,
      timeBudgetMs: TIME_BUDGET_MS,
      cursor,
      onProgress: async (next) => {
        // Kirayi kaybettiysek DUR: baska worker devraldi, yazmaya devam etmek
        // onun ilerlemesini ezer.
        if (!(await saveProgress(job.id, leaseToken, next))) {
          leaseLost = true;
          throw new Error('lease lost');
        }
      },
    });

    if (outcome.done) {
      const finished = await finishJob(job.id, leaseToken, outcome.cursor);
      return NextResponse.json({
        claimed: true,
        jobId: job.id,
        user: job.lastfmUser,
        status: finished ? 'done' : 'lease-lost',
        result: { ...outcome.cursor, worklist: undefined },
      });
    }

    const released = await releaseJob(job.id, leaseToken, outcome.cursor);
    return NextResponse.json({
      claimed: true,
      jobId: job.id,
      user: job.lastfmUser,
      status: released ? 'requeued' : 'lease-lost',
      progress: `${outcome.cursor.processed ?? 0}/${outcome.cursor.scored ?? 0}`,
    });
  } catch (error) {
    const message = (error as Error).message;
    // Kira kaybi bir HATA degil: is baska worker'da devam ediyor, `attempts`
    // artirilmamali ve durum ellenmemeli.
    if (message === 'lease lost') {
      return NextResponse.json({ claimed: true, jobId: job.id, status: 'lease-lost' });
    }
    const outcome = await failJob(job.id, leaseToken, message);
    return NextResponse.json(
      { claimed: true, jobId: job.id, status: outcome, error: message },
      { status: outcome === 'failed' ? 500 : 200 },
    );
  }
}
