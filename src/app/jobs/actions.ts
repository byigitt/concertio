'use server';

import { revalidatePath } from 'next/cache';
import { enqueueJob } from '@/lib/jobs';

export interface QueueState {
  ok: boolean;
  message: string;
  jobId?: string;
}

/**
 * Site uzerinden yenileme talebi. CLI'daki `pnpm faz0 --user=X --metro=Y`
 * yerine gecer.
 *
 * Auth yok: herkes herhangi bir Last.fm kullanici adi icin talep acabilir.
 * Zararsiz, cunku Last.fm profilleri zaten public ve yazilan tek sey o
 * kullanicinin kendi taste verisi — ev adresi gibi hassas bir alan yok.
 * Kotuye kullanimi `enqueueJob` icindeki cooldown + kuyruk derinligi siniri
 * tutuyor; ucuncu taraf kotasi (Last.fm/TM/MusicBrainz) boylece korunuyor.
 */
export async function queueRefresh(_prev: QueueState, form: FormData): Promise<QueueState> {
  const user = String(form.get('u') ?? '').trim();
  const metro = String(form.get('metro') ?? '').trim();
  if (!user) return { ok: false, message: 'last.fm username needed' };
  if (!metro) return { ok: false, message: 'area needed' };

  const outcome = await enqueueJob(user, metro);
  revalidatePath('/jobs');
  revalidatePath('/me');
  if (!outcome.ok) return { ok: false, message: outcome.reason };
  return {
    ok: true,
    jobId: outcome.job.id,
    message: outcome.created ? 'queued' : 'already queued',
  };
}
