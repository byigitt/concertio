import { notFound } from 'next/navigation';

import { metroBySlug, upcomingInMetro } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const EVENT_LIMIT = 100;

const TZ = 'America/Los_Angeles';
const dateFmt = new Intl.DateTimeFormat('tr-TR', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('tr-TR', {
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
      <h1>{metro.name} — yaklaşan konserler</h1>

      <p>
        {[metro.state, metro.country].filter(Boolean).join(', ')}
        {' · '}
        {events.length} etkinlik{events.length === EVENT_LIMIT ? ` (ilk ${EVENT_LIMIT})` : ''}
        {' · '}kişiselleştirme yok
        {' · '}
        <a href={`/me?metro=${metro.slug}`}>kendi eşleşmelerine bak</a>
      </p>

      {events.length === 0 ? (
        <>
          <p>Bu bölge için veritabanında gelecek etkinlik yok.</p>
          <ul>
            <li>
              Şemayı kur: <code>pnpm db:migrate</code>
            </li>
            <li>
              Veriyi çek: <code>pnpm faz0 --user=&lt;lastfm&gt; --metro={metro.slug}</code>
            </li>
          </ul>
        </>
      ) : (
        <div className="scroll-x">
          <table>
            <caption>Tarih sırasına göre; en yakın tarih üstte.</caption>
            <thead>
              <tr>
                <th scope="col">Tarih</th>
                <th scope="col">Sanatçı</th>
                <th scope="col">Mekân</th>
                <th scope="col">Bilet</th>
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
                          Bilet
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
        Etkinlik verisi <a href="https://www.ticketmaster.com/">Ticketmaster</a> Discovery
        API&apos;sinden; bilet bağlantıları doğrudan biletin satıldığı siteye gider.
      </p>
    </>
  );
}
