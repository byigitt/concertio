import { HomePanel } from '@/app/me/home-panel';
import { hasEditAccess, locationFeatureEnabled } from '@/lib/edit-access';
import {
  homeForUser,
  listMetros,
  matchesForUser,
  metroBySlug,
  reachCounts,
  upcomingInMetro,
} from '@/lib/queries';
import { formatDistance, isReach, REACH_ORDER, REACH_TIERS, type Reach } from '@/lib/reach';

export const dynamic = 'force-dynamic';

// Faz 0 tek metro (SF Bay) oldugu icin sabit saat dilimi yeterli; metro basina
// timezone kolonu semada yok, coklu metroya gecerken oraya eklenecek.
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

function UserForm({ metroSlug, defaultUser }: { metroSlug?: string; defaultUser?: string }) {
  return (
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
          defaultValue={defaultUser ?? ''}
        />
        {metroSlug ? <input type="hidden" name="metro" value={metroSlug} /> : null}{' '}
        <button type="submit">show</button>
      </p>
    </form>
  );
}

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ u?: string; metro?: string; reach?: string }>;
}) {
  const { u, metro: metroParam, reach: reachParam } = await searchParams;
  const lastfmUser = u?.trim();
  const metros = await listMetros();

  if (!lastfmUser) {
    return (
      <>
        <h1>username required</h1>
        <p>
          this page works by reading a last.fm profile. type the username; no password and no
          authorization needed.
        </p>
        <UserForm metroSlug={metros[0]?.slug} />
      </>
    );
  }

  const requestedSlug = metroParam?.trim() || metros[0]?.slug;
  const metro = requestedSlug ? await metroBySlug(requestedSlug) : undefined;

  if (!metro) {
    return (
      <>
        <h1>area not found</h1>
        <p>
          {requestedSlug ? (
            <>
              there is no area called <code>{requestedSlug}</code>.
            </>
          ) : (
            'no active area in the database.'
          )}{' '}
          active areas are listed on the <a href="/">start page</a>.
        </p>
      </>
    );
  }

  // Ev konumu hassas veri: hem okuma hem yazma edit secret'i gerektiriyor
  // (src/lib/edit-access.ts). Erisim yoksa konum hic sorgulanmiyor.
  const canEditLocation = locationFeatureEnabled() && (await hasEditAccess());
  const home = canEditLocation ? await homeForUser(lastfmUser) : undefined;
  const hasHome = home?.lat !== null && home?.lat !== undefined;
  const reach: Reach = hasHome && isReach(reachParam) ? reachParam : 'all';

  // Yakinlik filtresi metro sinirini asabilir: "ayni ulke" secildiyse tek
  // metroya kisitlamak filtreyi anlamsiz kilar.
  const crossMetro = hasHome && (reach === 'country' || reach === 'all');
  const [matches, counts] = await Promise.all([
    matchesForUser({
      lastfmUser,
      metroSlug: crossMetro ? undefined : metro.slug,
      reach,
      home,
    }),
    reachCounts(lastfmUser, home),
  ]);
  const metroHasEvents = matches.length > 0 || (await upcomingInMetro(metro.slug, 1)).length > 0;

  return (
    <>
      <h1>
        matches for{' '}
        <a href={`https://www.last.fm/user/${encodeURIComponent(lastfmUser)}`}>{lastfmUser}</a>
      </h1>

      <p>
        area: <a href={`/metro/${metro.slug}`}>{metro.name}</a>
        {' · '}
        {matches.length} concerts
        {hasHome ? (
          <>
            {' · '}filter: {REACH_TIERS[reach].label} ({REACH_TIERS[reach].hint})
          </>
        ) : null}
        {' · '}
        <a href="/me">another user</a>
      </p>

      <HomePanel
        lastfmUser={lastfmUser}
        metroSlug={metro.slug}
        featureEnabled={locationFeatureEnabled()}
        hasAccess={canEditLocation}
        homeLabel={home?.label ?? null}
      />

      {hasHome ? (
        <nav aria-label="proximity filter">
          <h2>filter</h2>
          <ul>
            {REACH_ORDER.map((tier) => {
              const params = new URLSearchParams({ u: lastfmUser, metro: metro.slug, reach: tier });
              const active = tier === reach;
              const count = counts?.[tier];
              return (
                <li key={tier}>
                  {active ? (
                    <span aria-current="true">
                      {REACH_TIERS[tier].label}
                      {count === undefined ? '' : ` (${count})`}
                    </span>
                  ) : (
                    <a href={`/me?${params.toString()}`}>
                      {REACH_TIERS[tier].label}
                      {count === undefined ? '' : ` (${count})`}
                    </a>
                  )}
                  {' — '}
                  {REACH_TIERS[tier].hint}
                </li>
              );
            })}
          </ul>
          <p>
            distances are straight-line, not real road or transit routes. every row shows the
            distance as well, so the call is yours.
          </p>
        </nav>
      ) : null}

      <h2>concerts</h2>

      {matches.length === 0 ? (
        <>
          <p>
            {metroHasEvents
              ? `there are concerts in the ${metro.name} calendar, but none match this filter.`
              : `no upcoming events for ${metro.name} in the database.`}
          </p>
          <ul>
            {hasHome && reach !== 'all' ? (
              <li>
                widen the filter:{' '}
                <a href={`/me?u=${encodeURIComponent(lastfmUser)}&metro=${metro.slug}&reach=all`}>
                  anywhere
                </a>
                .
              </li>
            ) : null}
            <li>
              refresh taste and event data: <code>pnpm faz0 --user={lastfmUser} --metro=
              {metro.slug}</code>
            </li>
            <li>
              see the whole area calendar: <a href={`/metro/${metro.slug}`}>{metro.name}</a>
            </li>
          </ul>
        </>
      ) : (
        <div className="scroll-x">
          <table>
            <caption>
              ordered by taste score; on a tie the closer one comes first. when more than one of
              your artists plays the same show, the highest scoring one is shown.
            </caption>
            <thead>
              <tr>
                <th scope="col">date</th>
                <th scope="col">artist</th>
                <th scope="col">venue</th>
                {hasHome ? <th scope="col">distance</th> : null}
                <th scope="col">score</th>
                <th scope="col">ticket</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((match) => {
                const ticket =
                  match.ticketUrls.find((t) => t.source === 'ticketmaster') ?? match.ticketUrls[0];
                const iso = match.startsAt.toISOString();
                return (
                  <tr key={match.eventId}>
                    <td>
                      <time dateTime={iso}>
                        {dateFmt.format(match.startsAt)} {timeFmt.format(match.startsAt)}
                      </time>
                    </td>
                    <td>
                      {match.artistName}
                      {match.billing === 'support' ? ' (support)' : ''}
                      {match.title && match.title !== match.artistName ? (
                        <>
                          <br />
                          {match.title}
                        </>
                      ) : null}
                    </td>
                    <td>
                      {match.venueName}
                      {match.venueCity ? `, ${match.venueCity}` : ''}
                    </td>
                    {hasHome ? (
                      <td>
                        {match.reach ? REACH_TIERS[match.reach].label : '—'}
                        {formatDistance(match.distanceMeters) ? (
                          <>
                            <br />
                            <span className="num">{formatDistance(match.distanceMeters)}</span>
                          </>
                        ) : null}
                      </td>
                    ) : null}
                    <td className="num" title={`signals: ${match.sources.join(', ')}`}>
                      {Math.round(match.score)}
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
        ticket links go straight to wherever the ticket is sold — mostly ticketmaster, sometimes
        ticketweb.
      </p>
    </>
  );
}
