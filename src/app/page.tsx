import { listMetros } from '@/lib/queries';

// Metro listesi DB'den geliyor; build aninda veritabani olmayabilir.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const metros = await listMetros();
  const defaultMetro = metros[0];

  return (
    <>
      <h1>Dinlediklerin şehre geldiğinde haberin olsun</h1>

      <p>
        concertio Last.fm dinleme geçmişini okur, sanatçı kimliklerini MusicBrainz ile eşleştirir ve
        Ticketmaster&apos;daki gelecek konserlerle karşılaştırır. Geriye tek bir liste kalır: senin
        sanatçıların, senin bölgende, tarih sırasıyla. Ev adresini girersen liste yürüme mesafesi,
        toplu taşıma ve gün dönüşü olarak filtrelenir.
      </p>

      <h2>Listeni aç</h2>

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
            aria-describedby="u-hint"
            defaultValue=""
          />
          {defaultMetro ? <input type="hidden" name="metro" value={defaultMetro.slug} /> : null}{' '}
          <button type="submit">Eşleşmeleri göster</button>
        </p>
        <p id="u-hint">
          Şifre veya izin gerekmez: Last.fm profili herkese açıksa kullanıcı adı yeterli. Profilin
          yoksa <a href="https://www.last.fm/join">Last.fm&apos;e kaydolabilirsin</a>.
        </p>
      </form>

      <h2>Nasıl çalışıyor</h2>

      <ol>
        <li>
          <strong>Zevk:</strong> Last.fm&apos;den en çok dinlediklerin (üç ayrı dönem), beğendiğin
          parçalar ve son çalınanlar okunur. Yakın geçmiş daha ağır sayılır.
        </li>
        <li>
          <strong>Kimlik:</strong> her sanatçı MusicBrainz&apos;e bağlanır. Bağ kesin değilse
          eşleştirme <em>yapılmaz</em>, elle inceleme kuyruğuna düşer — yanlış eşleşme, kaçırılan
          eşleşmeden pahalıdır.
        </li>
        <li>
          <strong>Konser:</strong> her sanatçı için Ticketmaster&apos;a tek sorgu gider. Coğrafya
          filtresi sonradan uygulanır, yani aynı sorgu tüm ülkeyi kapsar.
        </li>
        <li>
          <strong>Liste:</strong> kesişim zevk skoruna göre sıralanır; ev adresi varsa her satır
          mesafesiyle etiketlenir.
        </li>
      </ol>

      <h2>Aktif bölgeler</h2>

      {metros.length === 0 ? (
        <p>
          Veritabanında aktif bölge yok. Şemayı kur ve ilk veriyi çek:{' '}
          <code>pnpm db:migrate</code>, ardından <code>pnpm faz0</code>.
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
