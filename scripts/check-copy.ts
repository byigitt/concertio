#!/usr/bin/env tsx
/**
 * Caveman metin kapisi. AG icin yalnizca kendi sunucusuna baglanir; API key yok.
 *
 * Neden script: "olctum" iddiasi elle yapilinca bayatliyor - metni kisaltip
 * sayiyi guncellemeyi unutmak yeterli. Burada sayilar kaynaktan uretiliyor.
 *
 * Sayilan sey PROSE: tablo, nav, header ve footer disarida. Tablo veri tasir,
 * onu kismak amac degil; kisilmasi gereken aciklama metni.
 *
 * Kullanim: `pnpm dev` acikken `pnpm test:copy` (ya da BASE_URL ver).
 */
// Top-level `await` icin dosya modul olmali (TS1375); import'u yok, o yuzden bu.
export {};

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

/**
 * Rota basina prose kelime tavani - mevcut degerin hemen ustunde, yoksa kapi
 * hicbir seyi tutmaz. Asilirsa metin yeniden yaziliyor, tavan buyumuyor.
 */
const CAPS: Record<string, number> = {
  '/': 75,
  '/jobs': 35,
  '/me?u=yeterli&metro=sf-bay-area': 55,
  '/me': 20,
  '/metro/sf-bay-area': 30,
};

/**
 * Tek metin blogu kelime tavani. Fragment yaz, cumle yazma.
 * Veri kaynakli metin (tur adi, mekan) tabloda oldugu icin buraya girmiyor.
 */
const MAX_BLOCK_WORDS = 12;

const STRIP_BLOCKS = /<(script|style|template|table|nav|header|footer)\b[\s\S]*?<\/\1>/gi;

function proseBlocks(html: string): string[] {
  const body = html.replace(STRIP_BLOCKS, ' ');
  return body
    .split(/<[^>]+>/)
    .map((chunk) =>
      chunk
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&middot;/g, '·')
        .replace(/&mdash;/g, '—')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((chunk) => chunk.length > 0 && /[a-z0-9]/i.test(chunk));
}

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

let failures = 0;
const rows: string[] = [];

/**
 * Dogru uygulamaya baktigimizi teyit et. `next dev` port 3000 mesgulse sessizce
 * 3001'e kayiyor, yani 3000'de baska bir proje olabilir; onun metnini olcup
 * "gecti" demek en kotu sonuc. Isim yoksa hemen dur.
 */
const rootHtml = await fetch(BASE)
  .then((r) => r.text())
  .catch((e: unknown) => {
    console.error(`FAIL ${BASE} unreachable: ${(e as Error).message}`);
    console.error('     start the app first, or pass BASE_URL=http://localhost:<port>');
    process.exit(1);
  });
if (!/concertio/i.test(rootHtml)) {
  console.error(`FAIL ${BASE} does not look like concertio (no "concertio" in html)`);
  console.error('     another app is probably on that port; pass BASE_URL=http://localhost:<port>');
  process.exit(1);
}

for (const [route, cap] of Object.entries(CAPS)) {
  const response = await fetch(`${BASE}${route}`);
  if (!response.ok) {
    console.error(`FAIL ${route} -> HTTP ${response.status}`);
    failures += 1;
    continue;
  }
  const blocks = proseBlocks(await response.text());
  const total = blocks.reduce((sum, b) => sum + words(b), 0);
  const longest = blocks.filter((b) => words(b) > MAX_BLOCK_WORDS);

  rows.push(`${route.padEnd(34)} ${String(total).padStart(4)} / ${cap}`);
  if (total > cap) {
    console.error(`FAIL ${route}: ${total} prose words > cap ${cap}`);
    failures += 1;
  }
  for (const block of longest) {
    console.error(`FAIL ${route}: ${words(block)} words in one block > ${MAX_BLOCK_WORDS}`);
    console.error(`     "${block.slice(0, 110)}"`);
    failures += 1;
  }
}

console.log('\nprose words per route (tables/nav/header/footer excluded)');
for (const row of rows) console.log(`  ${row}`);

if (failures > 0) {
  console.error(`\n${failures} copy check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log('\nall routes within caveman caps.');
}
