import { HomePanel } from '@/app/me/home-panel';
import { hasEditAccess, locationFeatureEnabled } from '@/lib/edit-access';
import { formatDistance, isReach, REACH_ORDER, REACH_TIERS, type Reach } from '@/lib/reach';
import {
  homeForUser,
  listMetros,
  matchesForUser,
  metroBySlug,
  upcomingInMetro,
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

// Faz 0 tek metro (SF Bay) oldugu icin sabit saat dilimi yeterli; metro basina
// timezone kolonu semada yok, coklu metroya gecerken oraya eklenecek.
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

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ u?: string; metro?: string; reach?: string }>;
}) {
  const { u, metro: metroParam, reach: reachParam } = await searchParams;
  const lastfmUser = u?.trim();
  const metros = await listMetros();

  if (!lastfmUser) {
    const defaultMetro = metros[0];
    return (
      <div className="max-w-xl space-y-6">
        <h1 className="font-display text-3xl tracking-tight">Kullanici adi lazim</h1>
        <p className="text-sm leading-relaxed text-muted">
          Bu sayfa bir Last.fm profiline bakarak calisiyor. Kullanici adini yaz; parola ya da
          yetkilendirme istemiyoruz.
        </p>
        <form action="/me" method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-1 flex-col gap-2">
            <span className="text-sm text-muted">Last.fm kullanici adi</span>
            <input
              type="text"
              name="u"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="yeterli"
              className="w-full border-b border-line bg-transparent pb-2 font-display text-lg text-paper placeholder:text-faint focus:border-accent focus:outline-none"
            />
          </label>
          {defaultMetro ? <input type="hidden" name="metro" value={defaultMetro.slug} /> : null}
          <button
            type="submit"
            className="border border-line px-5 py-2 text-sm text-paper transition-colors hover:border-accent hover:text-accent"
          >
            Devam
          </button>
        </form>
        <p className="text-xs text-faint">
          Zevk sinyali{' '}
          <a href="https://www.last.fm/" rel="noreferrer" target="_blank">
            Last.fm
          </a>{' '}
          verisinden turetilir.
        </p>
      </div>
    );
  }

  const requestedSlug = metroParam?.trim() || metros[0]?.slug;
  const metro = requestedSlug ? await metroBySlug(requestedSlug) : undefined;

  if (!metro) {
    return (
      <div className="max-w-xl space-y-6">
        <h1 className="font-display text-3xl tracking-tight">Bolge bulunamadi</h1>
        <p className="text-sm leading-relaxed text-muted">
          {requestedSlug ? (
            <>
              <span className="font-mono text-paper">{requestedSlug}</span> diye bir bolge yok.
            </>
          ) : (
            'Veritabaninda aktif bolge yok.'
          )}{' '}
          Aktif bolgeler ana sayfada listeleniyor.
        </p>
        <a href="/" className="text-sm text-accent">
          Ana sayfa
        </a>
      </div>
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
  const matches = await matchesForUser({
    lastfmUser,
    metroSlug: crossMetro ? undefined : metro.slug,
    reach,
    home,
  });
  const metroHasEvents = matches.length > 0 || (await upcomingInMetro(metro.slug, 1)).length > 0;

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <p className="text-xs uppercase tracking-[0.18em] text-faint">{metro.name}</p>
        <h1 className="font-display text-3xl tracking-tight sm:text-4xl">
          <a
            href={`https://www.last.fm/user/${encodeURIComponent(lastfmUser)}`}
            target="_blank"
            rel="noreferrer"
            className="text-accent"
          >
            {lastfmUser}
          </a>{' '}
          icin eslesmeler
        </h1>
        {matches.length > 0 ? (
          <p className="text-sm text-muted">
            <span className="tabular-nums">{matches.length}</span> konser · zevk skoruna gore
            sirali
          </p>
        ) : null}
      </header>

      <HomePanel
        lastfmUser={lastfmUser}
        featureEnabled={locationFeatureEnabled()}
        hasAccess={canEditLocation}
        homeLabel={home?.label ?? null}
      />

      {hasHome ? (
        <nav aria-label="Yakinlik filtresi" className="flex flex-wrap gap-x-5 gap-y-2">
          {REACH_ORDER.map((tier) => {
            const params = new URLSearchParams({ u: lastfmUser, metro: metro.slug, reach: tier });
            const active = tier === reach;
            return (
              <a
                key={tier}
                href={`/me?${params.toString()}`}
                aria-current={active ? 'page' : undefined}
                title={REACH_TIERS[tier].hint}
                className={
                  active
                    ? 'border-b border-accent pb-1 text-sm text-accent'
                    : 'border-b border-transparent pb-1 text-sm text-muted transition-colors hover:text-paper'
                }
              >
                {REACH_TIERS[tier].label}
              </a>
            );
          })}
        </nav>
      ) : null}

      {matches.length === 0 ? (
        <section className="max-w-xl space-y-4 border-l-2 border-accent-dim pl-5">
          <h2 className="font-display text-xl">
            {metroHasEvents ? 'Bu bolgede eslesme cikmadi' : 'Veri henuz cekilmedi'}
          </h2>
          {metroHasEvents ? (
            <p className="text-sm leading-relaxed text-muted">
              {metro.name} takviminde konser var ama hicbiri{' '}
              <span className="text-paper">{lastfmUser}</span> profilinin sanatcilariyla
              ortusmuyor. Ya profil zevki henuz cekilmedi ya da bu donem gercekten bos. Zevk
              verisini tazelemek icin{' '}
              <span className="font-mono text-paper">
                pnpm faz0 --user={lastfmUser} --metro={metro.slug}
              </span>{' '}
              calistir; ayrica{' '}
              <a href={`/metro/${metro.slug}`} className="text-accent">
                bolgedeki tum konserlere
              </a>{' '}
              bakabilirsin.
            </p>
          ) : (
            <p className="text-sm leading-relaxed text-muted">
              Veritabaninda {metro.name} icin gelecek etkinlik yok. Faz 0 boru hattini calistir:{' '}
              <span className="font-mono text-paper">pnpm db:migrate</span> ile semayi kur,{' '}
              <span className="font-mono text-paper">
                pnpm faz0 --user={lastfmUser} --metro={metro.slug}
              </span>{' '}
              ile
              Last.fm zevkini ve Ticketmaster etkinliklerini cek. Ardindan bu sayfayi yenile.
            </p>
          )}
        </section>
      ) : (
        <ul className="border-t border-line">
          {matches.map((match) => {
            const ticket =
              match.ticketUrls.find((t) => t.source === 'ticketmaster') ?? match.ticketUrls[0];
            return (
              <li
                key={match.eventId}
                className="grid grid-cols-1 gap-2 border-b border-line py-5 sm:grid-cols-[6.5rem_1fr_auto] sm:gap-6"
              >
                <div className="font-mono text-xs tabular-nums text-muted sm:pt-1">
                  <span className="text-paper">{dayFmt.format(match.startsAt)}</span>
                  <span className="ml-2 sm:ml-0 sm:block">{timeFmt.format(match.startsAt)}</span>
                </div>

                <div className="min-w-0 space-y-1">
                  <p className="font-display text-lg leading-snug">
                    {match.artistName}
                    {match.billing === 'support' ? (
                      <span className="ml-2 align-middle text-[0.65rem] uppercase tracking-[0.14em] text-faint">
                        acilis
                      </span>
                    ) : null}
                  </p>
                  <p className="text-sm text-muted">
                    {match.venueName}
                    {match.venueCity ? ` · ${match.venueCity}` : ''}
                  </p>
                  {match.reach ? (
                    <p className="text-xs text-faint">
                      <span className="uppercase tracking-[0.14em]">
                        {REACH_TIERS[match.reach].label}
                      </span>
                      {formatDistance(match.distanceMeters) ? (
                        <span className="ml-2 font-mono tabular-nums">
                          {formatDistance(match.distanceMeters)}
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                  {match.title && match.title !== match.artistName ? (
                    <p className="text-xs text-faint">{match.title}</p>
                  ) : null}
                </div>

                <div className="flex items-center gap-4 sm:flex-col sm:items-end sm:gap-2">
                  <span
                    className="font-mono text-sm tabular-nums text-accent"
                    title={`Zevk skoru · kaynak: ${match.sources.join(', ')}`}
                  >
                    <span className="sr-only">Zevk skoru </span>
                    {Math.round(match.score)}
                  </span>
                  {ticket ? (
                    <a
                      href={ticket.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${match.artistName} icin bilet (yeni sekme)`}
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
        ; bilet linkleri dogrudan Ticketmaster&apos;a gider. Zevk sinyali{' '}
        <a
          href={`https://www.last.fm/user/${encodeURIComponent(lastfmUser)}`}
          target="_blank"
          rel="noreferrer"
        >
          Last.fm
        </a>{' '}
        dinleme gecmisinden, sanatci kimlikleri{' '}
        <a href="https://musicbrainz.org/" target="_blank" rel="noreferrer">
          MusicBrainz
        </a>
        &apos;ten gelir.
      </p>
    </div>
  );
}
