import { notFound } from 'next/navigation';

import { metroBySlug, upcomingInMetro } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const EVENT_LIMIT = 100;

const dayFmt = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'America/Los_Angeles',
  day: '2-digit',
  month: 'short',
});
const timeFmt = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'America/Los_Angeles',
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
    <div className="space-y-10">
      <header className="space-y-3">
        <p className="text-xs uppercase tracking-[0.18em] text-faint">
          {[metro.state, metro.country].filter(Boolean).join(' · ')}
        </p>
        <h1 className="font-display text-3xl tracking-tight sm:text-4xl">
          {metro.name} · yaklasan konserler
        </h1>
        <p className="text-sm text-muted">
          Kisisellestirme yok, takvimin tamami.{' '}
          <a href={`/me?metro=${metro.slug}`} className="text-accent">
            Kendi listen
          </a>{' '}
          icin Last.fm kullanici adini gir.
        </p>
      </header>

      {events.length === 0 ? (
        <section className="max-w-xl space-y-4 border-l-2 border-accent-dim pl-5">
          <h2 className="font-display text-xl">Takvim bos</h2>
          <p className="text-sm leading-relaxed text-muted">
            {metro.name} icin veritabaninda gelecek etkinlik yok. Faz 0 cekimini calistir:{' '}
            <span className="font-mono text-paper">
              pnpm faz0 --user=&lt;lastfm&gt; --metro={metro.slug}
            </span>
            . Cekim bittiginde konserler burada tarih sirasiyla listelenir.
          </p>
        </section>
      ) : (
        <ul className="border-t border-line">
          {events.map((event) => {
            const ticket =
              event.ticketUrls.find((t) => t.source === 'ticketmaster') ?? event.ticketUrls[0];
            const headline =
              event.headliners.length > 0 ? event.headliners.join(', ') : (event.title ?? 'Konser');
            return (
              <li
                key={event.eventId}
                className="grid grid-cols-1 gap-2 border-b border-line py-5 sm:grid-cols-[6.5rem_1fr_auto] sm:gap-6"
              >
                <div className="font-mono text-xs tabular-nums text-muted sm:pt-1">
                  <span className="text-paper">{dayFmt.format(event.startsAt)}</span>
                  <span className="ml-2 sm:ml-0 sm:block">{timeFmt.format(event.startsAt)}</span>
                </div>

                <div className="min-w-0 space-y-1">
                  <p className="font-display text-lg leading-snug">{headline}</p>
                  <p className="text-sm text-muted">
                    {event.venueName}
                    {event.venueCity ? ` · ${event.venueCity}` : ''}
                  </p>
                  {event.title && event.title !== headline ? (
                    <p className="text-xs text-faint">{event.title}</p>
                  ) : null}
                </div>

                <div className="sm:pt-1 sm:text-right">
                  {ticket ? (
                    <a
                      href={ticket.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${headline} icin bilet (yeni sekme)`}
                      className="text-sm text-muted transition-colors hover:text-accent"
                    >
                      Bilet
                    </a>
                  ) : (
                    <span className="text-sm text-faint">Bilet yok</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs leading-relaxed text-faint">
        Event data by{' '}
        <a href="https://www.ticketmaster.com/" target="_blank" rel="noreferrer">
          Ticketmaster
        </a>
        ; bilet linkleri dogrudan Ticketmaster&apos;a gider.
      </p>
    </div>
  );
}
