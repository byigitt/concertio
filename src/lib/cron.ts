/**
 * Vercel cron dogrulamasi. Vercel `Authorization: Bearer $CRON_SECRET` gonderir;
 * secret tanimli degilse (lokal gelistirme) sadece localhost'a izin verilir.
 * docs/07 K-7: cron `vercel.json` ile baslar, esik gecilince Inngest'e tasinir.
 */
export function assertCron(request: Request): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    const host = new URL(request.url).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return;
    throw new Error('CRON_SECRET is not set; remote call refused.');
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    throw new Error('cron request is not authorized.');
  }
}
