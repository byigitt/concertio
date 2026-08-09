import { listMetros } from '@/lib/queries';

// Metro listesi DB'den geliyor; build aninda veritabani olmayabilir.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const metros = await listMetros();
  const defaultMetro = metros[0];

  return (
    <>
      <h1>know when the music you listen to comes to town</h1>

      <p>
        concertio reads your last.fm listening history, resolves artist identity through
        musicbrainz, and compares it against upcoming shows on ticketmaster. what is left is one
        list: your artists, in your area, in date order. add your home address and the list can be
        filtered by walking distance, transit, or day trip.
      </p>

      <h2>open your list</h2>

      <form action="/me" method="get">
        <p>
          <label htmlFor="u">last.fm username</label>
          <br />
          <input
            id="u"
            name="u"
            required
            size={24}
            autoComplete="username"
            spellCheck={false}
            aria-describedby="u-hint"
            defaultValue=""
          />
          {defaultMetro ? <input type="hidden" name="metro" value={defaultMetro.slug} /> : null}{' '}
          <button type="submit">show matches</button>
        </p>
        <p id="u-hint">
          no password, no authorization: if the last.fm profile is public, the username is enough.
          no profile yet? <a href="https://www.last.fm/join">join last.fm</a>.
        </p>
      </form>

      <h2>how it works</h2>

      <ol>
        <li>
          <strong>taste:</strong> your top artists over three separate periods, your loved tracks,
          and recent scrobbles are read. recent listening counts for more.
        </li>
        <li>
          <strong>identity:</strong> every artist is linked to musicbrainz. when the link is not
          certain, no match is made — it goes to a manual review queue instead, because a wrong
          match costs more than a missed one.
        </li>
        <li>
          <strong>concerts:</strong> one query per artist goes to ticketmaster. the geographic
          filter is applied afterwards, so the same query covers the whole country.
        </li>
        <li>
          <strong>list:</strong> the intersection is ordered by taste score; with a home address
          every row is also labelled by distance.
        </li>
      </ol>

      <h2>active areas</h2>

      {metros.length === 0 ? (
        <p>
          no active area in the database. set up the schema and pull the first data:{' '}
          <code>pnpm db:migrate</code>, then <code>pnpm faz0</code>.
        </p>
      ) : (
        <ul>
          {metros.map((m) => (
            <li key={m.slug}>
              <a href={`/metro/${m.slug}`}>{m.name}</a>
              {m.state ? ` — ${m.state}, ${m.country}` : ` — ${m.country}`}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
