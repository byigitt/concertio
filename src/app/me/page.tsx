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

function UserForm({ metroSlug, defaultUser }: { metroSlug?: string; defaultUser?: string }) {
  return (
    <form action="/me" method="get">
      <p>
        <label htmlFor="u">Last.fm kullanıcı adı</label>
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
        <button type="submit">Göster</button>
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
        <h1>Kullanıcı adı gerekli</h1>
        <p>
          Bu sayfa bir Last.fm profiline bakarak çalışır. Kullanıcı adını yaz; parola ya da
          yetkilendirme istemiyoruz.
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
        <h1>Bölge bulunamadı</h1>
        <p>
          {requestedSlug ? (
            <>
              <code>{requestedSlug}</code> diye bir bölge yok.
            </>
          ) : (
            'Veritabanında aktif bölge yok.'
          )}{' '}
          Aktif bölgeler <a href="/">başlangıç sayfasında</a> listeleniyor.
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
        <a href={`https://www.last.fm/user/${encodeURIComponent(lastfmUser)}`}>{lastfmUser}</a> için
        eşleşmeler
      </h1>

      <p>
        Bölge: <a href={`/metro/${metro.slug}`}>{metro.name}</a>
        {' · '}
        {matches.length} konser
        {hasHome ? (
          <>
            {' · '}filtre: {REACH_TIERS[reach].label} ({REACH_TIERS[reach].hint})
          </>
        ) : null}
        {' · '}
        <a href="/me">başka kullanıcı</a>
      </p>

      <HomePanel
        lastfmUser={lastfmUser}
        metroSlug={metro.slug}
        featureEnabled={locationFeatureEnabled()}
        hasAccess={canEditLocation}
        homeLabel={home?.label ?? null}
      />

      {hasHome ? (
        <nav aria-label="Yakınlık filtresi">
          <h2>Filtre</h2>
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
            Mesafeler kuş uçuşu hesaplanır; gerçek yol ya da toplu taşıma rotası değildir. Her
            satırda mesafeyi de gösteriyoruz ki kararı sen verebilsin.
          </p>
        </nav>
      ) : null}

      <h2>Konserler</h2>

      {matches.length === 0 ? (
        <>
          <p>
            {metroHasEvents
              ? `${metro.name} takviminde konser var ama hiçbiri bu filtreyle eşleşmiyor.`
              : `Veritabanında ${metro.name} için gelecek etkinlik yok.`}
          </p>
          <ul>
            {hasHome && reach !== 'all' ? (
              <li>
                Filtreyi genişlet:{' '}
                <a href={`/me?u=${encodeURIComponent(lastfmUser)}&metro=${metro.slug}&reach=all`}>
                  her yer
                </a>
                .
              </li>
            ) : null}
            <li>
              Zevk ve etkinlik verisini tazele: <code>pnpm faz0 --user={lastfmUser} --metro=
              {metro.slug}</code>
            </li>
            <li>
              Bölgenin tüm takvimine bak: <a href={`/metro/${metro.slug}`}>{metro.name}</a>
            </li>
          </ul>
        </>
      ) : (
        <div className="scroll-x">
          <table>
            <caption>
              Zevk skoruna göre sıralı; eşit skorda yakın olan üstte. Bir konserde birden fazla
              sanatçın çalıyorsa en yüksek skorlu gösterilir.
            </caption>
            <thead>
              <tr>
                <th scope="col">Tarih</th>
                <th scope="col">Sanatçı</th>
                <th scope="col">Mekân</th>
                {hasHome ? <th scope="col">Uzaklık</th> : null}
                <th scope="col">Skor</th>
                <th scope="col">Bilet</th>
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
                      {match.billing === 'support' ? ' (açılış)' : ''}
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
                    <td className="num" title={`Kaynak: ${match.sources.join(', ')}`}>
                      {Math.round(match.score)}
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
        Bilet bağlantıları doğrudan biletin satıldığı siteye (çoğunlukla Ticketmaster, bazı
        etkinliklerde TicketWeb) gider.
      </p>
    </>
  );
}
