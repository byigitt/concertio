import { notFound } from 'next/navigation';

import { metroBySlug, upcomingInMetro } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const EVENT_LIMIT = 100;

const TZ = 'America/Los_Angeles';
const dateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export default async function MetroPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const metro = await metroBySlug(slug);
  if (!metro) notFound();

  const events = await upcomingInMetro(metro.slug, EVENT_LIMIT);

  return (
    <>
      <h1>{metro.name} — upcoming concerts</h1>

      <p>
        {[metro.state, metro.country].filter(Boolean).join(', ')}
        {' · '}
        {events.length} events{events.length === EVENT_LIMIT ? ` (first ${EVENT_LIMIT})` : ''}
        {' · '}
        <a href={`/me?metro=${metro.slug}`}>your matches</a>
      </p>

      {events.length === 0 ? (
        <>
          <p>no events stored for this area.</p>
          <ul>
            <li>
              schema: <code>pnpm db:migrate</code>
            </li>
            <li>
              data: <a href="/jobs">queue a refresh</a>
            </li>
          </ul>
        </>
      ) : (
        <div className="scroll-x">
          <table>
            <caption>date order, soonest first.</caption>
            <thead>
              <tr>
                <th scope="col">date</th>
                <th scope="col">artist</th>
                <th scope="col">venue</th>
                <th scope="col">ticket</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const ticket =
                  event.ticketUrls.find((t) => t.source === 'ticketmaster') ?? event.ticketUrls[0];
                const headliners = event.headliners.length > 0 ? event.headliners.join(', ') : null;
                return (
                  <tr key={event.eventId}>
                    <td>
                      <time dateTime={event.startsAt.toISOString()}>
                        {dateFmt.format(event.startsAt)} {timeFmt.format(event.startsAt)}
                      </time>
                    </td>
                    <td>{headliners ?? event.title ?? '—'}</td>
                    <td>
                      {event.venueName}
                      {event.venueCity ? `, ${event.venueCity}` : ''}
                    </td>
                    <td>
                      {ticket ? (
                        <a href={ticket.url} rel="noreferrer">
                          ticket
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p>
        event data by <a href="https://www.ticketmaster.com/">ticketmaster</a>. ticket links go to
        the seller.
      </p>
    </>
  );
}
