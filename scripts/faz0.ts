#!/usr/bin/env tsx
/**
 * Faz 0 CLI: tek kullanici, tek metro.
 *
 * Ayni isi site uzerinden kuyruga almak icin `/jobs` sayfasi ve
 * `/api/jobs/run` worker'i var. Bu script AYNI `refreshUser` fonksiyonunu
 * cagirir — mantik tek yerde durur, CLI ile worker ayrisamaz.
 *
 * CLI'da zaman butcesi cok genis: serverless siniri yok, is bolunmesin.
 */
import { pool, sql } from '../src/lib/db/client.ts';
import { refreshUser } from '../src/lib/refresh-user.ts';

/** CLI'da butce pratikte sinirsiz: bir saat. */
const CLI_TIME_BUDGET_MS = 60 * 60_000;

/**
 * Tarihler mekan yerel saatinde gosterilir; UTC yazmak "02:30" gibi yaniltici
 * cikiyor (gercekte onceki aksam 19:30).
 */
const METRO_TZ = process.env.CONCERTIO_METRO_TZ ?? 'America/Los_Angeles';
const dateFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: METRO_TZ,
  dateStyle: 'short',
  timeStyle: 'short',
});

interface Args {
  user: string;
  metroSlug: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  const user = flag('user') ?? process.env.CONCERTIO_LASTFM_USER;
  if (!user) {
    throw new Error('no user. pass --user=<lastfm> or set CONCERTIO_LASTFM_USER.');
  }
  return { user, metroSlug: flag('metro') ?? 'sf-bay-area', dryRun: argv.includes('--dry-run') };
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`# concertio faz0 — ${args.user} @ ${args.metroSlug}`);

  let lastLogged = -1;
  const outcome = await refreshUser({
    lastfmUser: args.user,
    metroSlug: args.metroSlug,
    timeBudgetMs: CLI_TIME_BUDGET_MS,
    skipEvents: args.dryRun,
    onProgress: async (cursor) => {
      const done = cursor.processed ?? 0;
      if (done !== lastLogged) {
        lastLogged = done;
        process.stdout.write(`\r   artists ${done}/${cursor.scored ?? 0}   `);
      }
    },
  });

  const c = outcome.cursor;
  console.log(
    `\n   ${c.signals} signals -> ${c.scored} artists -> ${c.linked} linked, ` +
      `${c.reviewed} in review, ${c.missingAttraction} without ticketmaster id`,
  );
  if (c.errors && c.errors.length > 0) {
    console.log(`   ${c.errors.length} errors:`);
    for (const e of c.errors.slice(0, 5)) console.log(`   ! ${e}`);
  }
  if (args.dryRun) {
    console.log('\n--dry-run: event fetch skipped.');
    return;
  }
  console.log(`   ${c.eventsSeen} events seen, ${c.eventsInserted} new`);

  const matches = await sql<{
    starts_at: Date;
    artist: string;
    score: number;
    venue: string;
    city: string | null;
    ticket_urls: Array<{ url: string }>;
  }>(
    `SELECT e.starts_at, a.name AS artist, ut.score, v.name AS venue, v.city, e.ticket_urls
       FROM app_user u
       JOIN user_taste ut ON ut.user_id = u.id
       JOIN event_artist ea ON ea.artist_id = ut.artist_id
       JOIN event e ON e.id = ea.event_id
       JOIN venue v ON v.id = e.venue_id
       JOIN artist a ON a.id = ut.artist_id
       JOIN metro_area m ON m.id = e.metro_area_id
      WHERE lower(u.lastfm_user) = lower($1)
        AND m.slug = $2
        AND e.starts_at > now()
        AND e.status <> 'cancelled'
      ORDER BY ut.score DESC, e.starts_at ASC`,
    [args.user, args.metroSlug],
  );

  console.log('\nmatches');
  if (matches.length === 0) {
    console.log('   none. raise CONCERTIO_TOP_ARTISTS or widen the window.');
    return;
  }
  for (const m of matches) {
    const where = m.city ? `${m.venue}, ${m.city}` : m.venue;
    console.log(
      `   ${dateFormatter.format(m.starts_at)}  ${m.artist}  (${m.score.toFixed(0)})  ${where}`,
    );
    console.log(`      ${m.ticket_urls[0]?.url ?? '-'}`);
  }
  console.log(`\n${matches.length} matches. event data by ticketmaster; taste data from last.fm.`);
}

await main();
await pool().end();
