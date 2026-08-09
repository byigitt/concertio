import { QueueForm } from '@/app/jobs/queue-form';
import { listMetros } from '@/lib/queries';

// Metro listesi DB'den geliyor; build aninda veritabani olmayabilir.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const metros = await listMetros();

  return (
    <>
      <h1>concerts by bands you play</h1>

      <p>your last.fm artists, your area, one list.</p>

      <h2>start</h2>
      <QueueForm metros={metros} />
      <p>
        no terminal. watch <a href="/jobs">queue</a>, then <a href="/me">matches</a>.
      </p>

      <h2>how</h2>
      <ol>
        <li>taste: top + loved + recent. recent weighs more.</li>
        <li>identity: musicbrainz. unsure = review, no match.</li>
        <li>concerts: ticketmaster per artist. geography after.</li>
        <li>list: taste order. home address adds distance.</li>
      </ol>

      <h2>areas</h2>
      {metros.length === 0 ? (
        <p>
          none. run <code>pnpm db:migrate</code>.
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
