import { QueueForm } from '@/app/jobs/queue-form';
import { listMetros } from '@/lib/queries';

// Metro listesi DB'den geliyor; build aninda veritabani olmayabilir.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const metros = await listMetros();

  return (
    <>
      <h1>concerts by bands you actually play</h1>

      <p>
        read last.fm history. resolve artist via musicbrainz. match against ticketmaster. one list,
        your artists, your area. add home address, filter by walk / transit / day trip.
      </p>

      <h2>start</h2>
      <QueueForm metros={metros} />
      <p>
        queue runs it, no terminal needed. watch it on <a href="/jobs">queue</a>. already refreshed
        once? go straight to <a href="/me">your matches</a>.
      </p>

      <h2>how</h2>
      <ol>
        <li>taste: top artists (3 periods) + loved + recent. recent counts more.</li>
        <li>identity: musicbrainz link. not certain = no match, goes to review.</li>
        <li>concerts: one ticketmaster query per artist. geography filtered after.</li>
        <li>list: sorted by taste score. home address adds distance per row.</li>
      </ol>

      <h2>areas</h2>
      {metros.length === 0 ? (
        <p>
          none active. run <code>pnpm db:migrate</code>.
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
