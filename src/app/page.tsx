import { listMetros } from '@/lib/queries';

// Metro listesi DB'den geliyor; build aninda veritabani olmayabilir.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const metros = await listMetros();
  const defaultMetro = metros[0];

  return (
    <div className="space-y-14">
      <section className="space-y-5">
        <h1 className="font-display text-4xl leading-[1.1] tracking-tight sm:text-5xl">
          Dinlediklerin sehre geldiginde
          <br />
          <span className="text-accent">haberin olsun.</span>
        </h1>
        <p className="max-w-xl text-base leading-relaxed text-muted">
          concertio Last.fm dinleme gecmisini okur, sanatci kimliklerini MusicBrainz ile
          eslestirir ve Ticketmaster&apos;daki gelecek konserlerle karsilastirir. Geriye tek bir
          liste kalir: senin sanatcilarin, senin sehrinde, tarih sirasiyla.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xs uppercase tracking-[0.18em] text-faint">Nasil calisiyor</h2>
        <ol className="space-y-3 text-sm leading-relaxed text-muted">
          <li className="flex gap-4">
            <span className="font-mono text-xs text-accent-dim tabular-nums">01</span>
            <span>
              Last.fm kullanici adin yeterli. Parola, OAuth, hesap acma yok — profilin herkese
              acik olsun kafi.
            </span>
          </li>
          <li className="flex gap-4">
            <span className="font-mono text-xs text-accent-dim tabular-nums">02</span>
            <span>
              En cok dinlediklerin, begendiklerin ve son calmalarin tek bir zevk skoruna donusur;
              cok populer isimler bilerek soner ki liste keskin kalsin.
            </span>
          </li>
          <li className="flex gap-4">
            <span className="font-mono text-xs text-accent-dim tabular-nums">03</span>
            <span>
              Sonuc sayfada durur. Bildirim, e-posta ya da abonelik yok; canin istediginde acar
              bakarsin.
            </span>
          </li>
        </ol>
      </section>

      <section className="space-y-4">
        <h2 className="text-xs uppercase tracking-[0.18em] text-faint">Listeni ac</h2>
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
            Eslesmeleri gor
          </button>
        </form>
        <p className="text-xs text-faint">
          Adres cubuguna da yazabilirsin:{' '}
          <span className="font-mono text-muted">
            /me?u=kullanici{defaultMetro ? `&metro=${defaultMetro.slug}` : ''}
          </span>
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xs uppercase tracking-[0.18em] text-faint">Aktif bolgeler</h2>
        {metros.length === 0 ? (
          <p className="max-w-xl text-sm leading-relaxed text-muted">
            Henuz aktif bolge yok. Semayi kur ve Faz 0 verisini cek:{' '}
            <span className="font-mono text-paper">pnpm db:migrate</span> ardindan{' '}
            <span className="font-mono text-paper">pnpm faz0</span>.
          </p>
        ) : (
          <ul className="border-t border-line">
            {metros.map((metro) => (
              <li key={metro.id} className="border-b border-line">
                <a
                  href={`/metro/${metro.slug}`}
                  className="flex items-baseline justify-between gap-4 py-4 no-underline transition-colors hover:text-accent"
                >
                  <span className="font-display text-lg">{metro.name}</span>
                  <span className="font-mono text-xs text-faint">
                    {[metro.state, metro.country].filter(Boolean).join(' · ')}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
