#!/usr/bin/env tsx
/**
 * Sizinti testi. Ag ve DB GEREKTIRMEZ.
 *
 * `/jobs` sayfasi PUBLIC ve `ingest_job.last_error` icerigini gosteriyor.
 * Hata mesajlari URL tasidigi ve URL'de `apikey`/`api_key` oldugu icin
 * redaksiyon olmadan API anahtari herkese gorunur.
 */
import { HttpStatusError, redactUrl } from '../src/lib/http.ts';

const SECRET = 'Vk0OWOORef3GgrfnyrPHblGIGTReXtOS';
let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`   ${ok ? 'OK  ' : 'FAIL'} ${label} — ${detail}`);
  if (!ok) failures += 1;
}

console.log('\n[1] redactUrl');
const cases = [
  `https://app.ticketmaster.com/discovery/v2/events.json?classificationName=music&apikey=${SECRET}`,
  `https://ws.audioscrobbler.com/2.0/?method=user.gettopartists&api_key=${SECRET}&format=json`,
  `https://example.test/x?token=${SECRET}&client_secret=${SECRET}`,
];
for (const raw of cases) {
  const safe = redactUrl(raw);
  check(
    `secret gone: ${new URL(raw).host}`,
    !safe.includes(SECRET) && safe.includes('REDACTED'),
    safe.slice(0, 90),
  );
}
check('non-url tolerated', redactUrl('not a url') === '(unparseable url)', redactUrl('not a url'));
check(
  'harmless params kept',
  redactUrl('https://x.test/a?page=2&size=100') === 'https://x.test/a?page=2&size=100',
  redactUrl('https://x.test/a?page=2&size=100'),
);

console.log('\n[2] HttpStatusError');
const err = new HttpStatusError(
  'ticketmaster',
  401,
  `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${SECRET}`,
  '{"fault":{"faultstring":"Invalid ApiKey"}}',
);
check('message has no secret', !err.message.includes(SECRET), err.message.slice(0, 100));
check('url field has no secret', !err.url.includes(SECRET), err.url.slice(0, 80));
check('status preserved', err.status === 401, `${err.status}`);
check('body snippet preserved', err.bodySnippet.includes('Invalid ApiKey'), err.bodySnippet);
// Hata nesnesinin HICBIR alaninda anahtar kalmamali (JSON dokumu ile bak).
const dumped = JSON.stringify({ ...err, message: err.message, stack: '' });
check('no secret anywhere on error', !dumped.includes(SECRET), `${dumped.length} chars scanned`);

if (failures > 0) {
  console.error(`\n${failures} kontrol BASARISIZ`);
  process.exitCode = 1;
} else {
  console.log('\nTum kontroller gecti.');
}
