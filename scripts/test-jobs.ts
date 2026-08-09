#!/usr/bin/env tsx
/**
 * Kuyruk testleri. API key ve ag GEREKTIRMEZ; DB gerekir.
 *
 * T1. enqueue: aktif is varsa YENI is acmaz, mevcudu doner.
 * T2. rate cap: cooldown icinde ikinci talep reddedilir.
 * T3. atomik claim: iki es zamanli claim ayni isi kapamaz.
 * T4. lease fencing: kirayi kaybeden worker'in yazmalari REDDEDILIR.
 * T5. stale claim: heartbeat eskiyen 'running' is geri alinabilir.
 * T6. release/finish: butce dolunca kuyruga doner, bitince 'done'.
 * T7. failJob: MAX_ATTEMPTS'e kadar requeue, sonra 'failed'.
 */
import { pool, sql, sqlOne } from '../src/lib/db/client.ts';
import {
  claimNextJob,
  enqueueJob,
  failJob,
  finishJob,
  jobById,
  MAX_ATTEMPTS,
  releaseJob,
  saveProgress,
} from '../src/lib/jobs.ts';

const SLUG = 'jobs-test-metro';
const USER_A = 'jobs-test-user-a';
const USER_B = 'jobs-test-user-b';
let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`   ${ok ? 'OK  ' : 'FAIL'} ${label} — ${detail}`);
  if (!ok) failures += 1;
}

async function cleanup(): Promise<void> {
  await sql("DELETE FROM ingest_job WHERE lastfm_user LIKE 'jobs-test-%'");
  await sql('DELETE FROM app_user WHERE lastfm_user LIKE $1', ['jobs-test-%']);
  await sql('DELETE FROM metro_area WHERE slug = $1', [SLUG]);
}

async function seedMetro(): Promise<void> {
  await sql(
    `INSERT INTO metro_area (source, source_id, name, state, slug, active, lat, lng)
     VALUES ('ticketmaster_dma', 'JOBSTEST', 'Jobs Test', 'CA', $1, true, 37.77, -122.41)
     ON CONFLICT (source, source_id) DO UPDATE SET active = true`,
    [SLUG],
  );
}

async function main(): Promise<void> {
  await seedMetro();

  console.log('\n[T1] enqueue tekilligi');
  const first = await enqueueJob(USER_A, SLUG);
  check('ilk talep is acti', first.ok && first.created, first.ok ? `created=${first.created}` : first.reason);
  const second = await enqueueJob(USER_A, SLUG);
  check(
    'ikinci talep ayni isi dondu',
    second.ok && !second.created && first.ok && second.job.id === first.job.id,
    second.ok ? `created=${second.created}` : second.reason,
  );
  const count = await sqlOne<{ n: number }>(
    'SELECT count(*)::int AS n FROM ingest_job WHERE lower(lastfm_user) = lower($1)',
    [USER_A],
  );
  check('tabloda tek satir', count?.n === 1, `${count?.n} satir`);

  console.log('\n[T2] rate cap');
  if (!first.ok) throw new Error('T1 basarisiz, devam edilemez');
  // Isi bitir, sonra hemen tekrar talep et: cooldown reddetmeli.
  const claimForFinish = await claimNextJob();
  if (!claimForFinish) throw new Error('claim edilemedi');
  await finishJob(claimForFinish.job.id, claimForFinish.leaseToken, { processed: 0 });
  const third = await enqueueJob(USER_A, SLUG);
  check('cooldown icinde reddedildi', !third.ok, third.ok ? 'kabul edildi (yanlis)' : third.reason);

  console.log('\n[T3] atomik claim');
  const jobB = await enqueueJob(USER_B, SLUG);
  check('B icin is acildi', jobB.ok, jobB.ok ? jobB.job.id.slice(0, 8) : jobB.reason);
  const [c1, c2] = await Promise.all([claimNextJob(), claimNextJob()]);
  const claimedIds = [c1?.job.id, c2?.job.id].filter(Boolean);
  check(
    'iki es zamanli claim -> tek is',
    claimedIds.length === 1,
    `${claimedIds.length} is kapildi`,
  );
  const winner = c1 ?? c2;
  if (!winner) throw new Error('hicbir claim basarili olmadi');
  check(
    'kira jetonu verildi',
    typeof winner.leaseToken === 'string' && winner.leaseToken.length === 36,
    `${winner.leaseToken}`,
  );

  console.log('\n[T4] lease fencing');
  const stolenToken = winner.leaseToken;
  // Baska worker devraliyormus gibi jetonu degistir.
  await sql('UPDATE ingest_job SET lease_token = uuid_generate_v4() WHERE id = $1', [winner.job.id]);
  check(
    'eski jetonla saveProgress reddedildi',
    (await saveProgress(winner.job.id, stolenToken, { processed: 99 })) === false,
    'false dondu',
  );
  check(
    'eski jetonla finishJob reddedildi',
    (await finishJob(winner.job.id, stolenToken, { processed: 99 })) === false,
    'false dondu',
  );
  check(
    'eski jetonla releaseJob reddedildi',
    (await releaseJob(winner.job.id, stolenToken, { processed: 99 })) === false,
    'false dondu',
  );
  check('eski jetonla failJob -> lost', (await failJob(winner.job.id, stolenToken, 'x')) === 'lost', 'lost');
  const afterFence = await jobById(winner.job.id);
  check(
    'is hala running ve cursor bozulmadi',
    afterFence?.status === 'running' && (afterFence?.cursor.processed ?? 0) !== 99,
    `status=${afterFence?.status} processed=${afterFence?.cursor.processed}`,
  );

  console.log('\n[T5] stale claim geri alinir');
  await sql("UPDATE ingest_job SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [
    winner.job.id,
  ]);
  const reclaimed = await claimNextJob();
  check('eskimis is tekrar kapildi', reclaimed?.job.id === winner.job.id, `${reclaimed?.job.id?.slice(0, 8)}`);
  check(
    'yeni jeton eskisinden farkli',
    reclaimed !== undefined && reclaimed.leaseToken !== stolenToken,
    'farkli',
  );

  console.log('\n[T6] release ve finish');
  if (!reclaimed) throw new Error('reclaim edilemedi');
  const attemptsBefore = (await jobById(reclaimed.job.id))?.attempts ?? 0;
  check(
    'release true dondu',
    (await releaseJob(reclaimed.job.id, reclaimed.leaseToken, { processed: 7, scored: 20 })) === true,
    'true',
  );
  const released = await jobById(reclaimed.job.id);
  check('durum queued', released?.status === 'queued', `${released?.status}`);
  check('cursor korundu', released?.cursor.processed === 7, `processed=${released?.cursor.processed}`);
  check(
    'attempts geri alindi (bolunme hata degil)',
    (released?.attempts ?? 0) === attemptsBefore - 1,
    `${attemptsBefore} -> ${released?.attempts}`,
  );

  const again = await claimNextJob();
  if (!again) throw new Error('yeniden claim edilemedi');
  check(
    'devam noktasi korunuyor',
    again.job.cursor.processed === 7,
    `processed=${again.job.cursor.processed}`,
  );
  check(
    'finish true dondu',
    (await finishJob(again.job.id, again.leaseToken, { processed: 20, matches: 3 })) === true,
    'true',
  );
  const done = await jobById(again.job.id);
  check('durum done', done?.status === 'done', `${done?.status}`);
  check('sonuc yazildi', done?.result?.matches === 3, `matches=${done?.result?.matches}`);

  console.log('\n[T7] failJob deneme siniri');
  await sql("DELETE FROM ingest_job WHERE lastfm_user LIKE 'jobs-test-%'");
  const jobC = await enqueueJob('jobs-test-user-c', SLUG);
  if (!jobC.ok) throw new Error(jobC.reason);
  let outcome: string = '';
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const c = await claimNextJob();
    if (!c) throw new Error(`claim ${i} basarisiz`);
    outcome = await failJob(c.job.id, c.leaseToken, `deneme ${i + 1}`);
    if (i < MAX_ATTEMPTS - 1) {
      check(`deneme ${i + 1}: requeued`, outcome === 'requeued', outcome);
    }
  }
  check(`deneme ${MAX_ATTEMPTS}: failed`, outcome === 'failed', outcome);
  const failed = await jobById(jobC.job.id);
  check('son durum failed', failed?.status === 'failed', `${failed?.status}`);
  check('hata mesaji yazildi', (failed?.lastError ?? '').includes('deneme'), `${failed?.lastError}`);
}

try {
  await cleanup();
  await main();
} finally {
  await cleanup();
  await pool().end();
}

if (failures > 0) {
  console.error(`\n${failures} kontrol BASARISIZ`);
  process.exitCode = 1;
} else {
  console.log('\nTum kontroller gecti.');
}
