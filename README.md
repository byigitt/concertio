# concertio

Last.fm'deki müzik zevkini bir bölgedeki gelecek konserlerle eşleştirir. İlk hedef SF Bay Area,
mimari ABD geneline açık. Tasarım ve araştırma notları `docs/` altında (gitignore'lu, lokal).

- Konser verisi: **Ticketmaster Discovery** (birincil). Songkick ToS nedeniyle kapsam dışı — `docs/07` K-2.
- Zevk verisi: **Last.fm** (birincil, OAuth gerekmez). Spotify opsiyonel — `docs/07` K-1.
- Sanatçı kimliği: **MusicBrainz** MBID + `url-rels` köprüsü — `docs/07` K-3.
- Tarama yönü: **artist-first**, metro taraması değil — `docs/07` K-4.
- Bildirim/e-posta yok — `docs/07` K-8.

## Kurulum

```bash
pnpm install
cp .env.example .env.local        # sonra doldur
createdb concertio                # veya Neon connection string kullan
pnpm db:migrate
```

`.env.local` içinde doldurulması gerekenler:

| Değişken | Nereden | Zorunlu mu |
|---|---|---|
| `DATABASE_URL` | lokal Postgres ya da Vercel Marketplace > Neon | evet |
| `LASTFM_API_KEY` | https://www.last.fm/api/account/create (ücretsiz) | evet |
| `TICKETMASTER_API_KEY` | https://developer.ticketmaster.com (ücretsiz, 5000 istek/gün) | evet |
| `MUSICBRAINZ_USER_AGENT` | `concertio/0.1 ( mailin@example.com )` — MusicBrainz anlamlı UA şart koşuyor | evet |
| `CONCERTIO_LASTFM_USER` | kendi Last.fm kullanıcı adın | Faz 0 için |
| `CRON_SECRET` | Vercel'de cron çağrılarını doğrulamak için | deploy'da |
| `CONCERTIO_EDIT_SECRET` | `openssl rand -hex 24` — ev konumu özelliğini açar (≥16 karakter) | konum için |

## Komutlar

```bash
pnpm smoke          # API key GEREKTİRMEZ — ingest/dedup/eşleme/sorgu zincirini fixture ile doğrular
pnpm test:pipeline  # API key ve ağ GEREKTİRMEZ — sayfalama tavanı + iptal kapısı testleri
pnpm test:reach     # API key ve ağ GEREKTİRMEZ — mesafe + yakınlık kademesi testleri
pnpm check:lastfm   # canlı Last.fm kontrolü: sinyal sayısı + MBID doluluk oranı
pnpm check:geocode  # canlı Nominatim kontrolü: adres -> koordinat
pnpm faz0           # tek kullanıcı + tek metro, uçtan uca gerçek veri (iki API key gerekir)
pnpm dev            # http://localhost:3000
pnpm typecheck
pnpm build
```

`pnpm faz0` seçenekleri: `--user=<lastfm>`, `--metro=<slug>`, `--dry-run` (etkinlik çekimini atlar,
Ticketmaster key'i gerektirmez). Ayar değişkenleri: `CONCERTIO_TOP_ARTISTS` (varsayılan 60),
`CONCERTIO_WINDOW_DAYS` (180), `CONCERTIO_METRO_RADIUS_KM` (80),
`CONCERTIO_METRO_TZ` (`America/Los_Angeles` — tarihler mekân yerel saatinde basılır).

İlk gerçek koşu (2026-08-09, kullanıcı `yeterli`, SF Bay Area): 865 Last.fm sinyali → 490 sanatçı
skorlandı → ilk 60'ı MusicBrainz ile çözümlendi (58 bağlandı, 2 geçici timeout) → 47 sanatçı için
Ticketmaster attraction id bulundu → **13 eşleşme**. MBID doluluk oranı Last.fm tarafında %72;
kalan %28 için MusicBrainz araması gerekiyor ve 1 istek/sn limiti koşu süresini belirliyor
(ilk koşu ~145 sn, sonraki koşular sanatçılar DB'de olduğu için ~60 sn).

### Ev konumu ve yakınlık filtresi

`/me` sayfasında ev adresi girilince her eşleşme eve olan mesafesine göre etiketlenir ve
filtrelenebilir. Kademeler `src/lib/reach.ts`'te tek yerde tanımlı:

| Kademe | Ölçüt | Not |
|---|---|---|
| Yürüyerek | ≤ 2 km | ~25 dk yürüyüş |
| Toplu taşıma | ≤ 15 km | şehir içi otobüs/metro |
| Aynı şehir | şehir adı eşleşmesi **veya** ≤ 15 km | idari sınır, mesafeden bağımsız |
| Gün dönüşü | ≤ 150 km | SF → Sacramento (120 km, tren ~2 sa) dahil olacak şekilde kalibre |
| Aynı ülke | ülke kodu eşleşmesi | farklı şehir, aynı ülke |
| Her yer | filtre yok | — |

**Mesafe düz hat (great-circle), yol veya toplu taşıma rotası değil.** Gerçek rota için GTFS/OTP
gerekir; o yüzden etiketler iddia değil tahmindir ve mesafe her satırda ayrıca gösterilir.
`Aynı ülke` ve `Her yer` seçildiğinde metro filtresi kaldırılır — aksi halde "farklı şehir"
filtresi tek metroya sıkışıp anlamsız olurdu. Adres çözümlemesi OSM Nominatim ile yapılır
(1 istek/sn, `User-Agent` zorunlu); sonuç `app_user`'a yazıldığı için kullanıcı başına tek istek.

**Erişim kontrolü — geçici.** Uygulamada henüz auth yok ve `?u=<lastfm>` kimlik doğrulamaz.
Ev adresi hassas veri olduğu için konum özelliği hem okuma hem yazma için
`CONCERTIO_EDIT_SECRET` bilmeyi gerektirir; secret tanımsızsa özellik tamamen kapalıdır
(fail closed). Doğrulanan secret'in sha256'sı httpOnly cookie'de tutulur. Kullanıcı adını
beyaz listeye almak yeterli olmazdı: kullanıcı adı herkese açık, secret değil. Faz 1'de Auth.js
gelince `src/lib/edit-access.ts` silinip sahiplik oturumdan okunacak.

### Eksik küme ve pencere kuralı (destructive işlemler için)

`markStaleCancelled` "bu koşuda gelmeyen etkinlik iptal edilmiştir" varsayımı yapar, o yüzden iki
koruma altında çalışır:

**1. Küme eksiksiz olmalı.** `EventSource.fetchEvents()` bir `EventFetchResult { events, complete,
totalAvailable }` döner. `complete=false` iki durumda olur: Ticketmaster'ın `size*page < 1000`
sayfalama tavanına çarpılırsa, veya sayfadaki bir kayıt `RawEvent`'e çevrilemezse (ör. tarihsiz
etkinlik). Küme eksikken iptal taraması **hiç çalışmaz** (`cancelled: null`) — aksi halde
çekilemeyen kayıtlar "gelmedi, demek iptal" sanılıp gerçek etkinlikler iptal işaretlenir.

**2. Tarama yalnız çekilen pencereyi kapsar.** `markStaleCancelled` `windowEnd` parametresi
zorunlu ve `refreshMetro` ona 90 günü (3 × 30) verir. `pnpm faz0` varsayılan olarak 180 gün ingest
ettiği için 91-180. günlerdeki etkinlikler cron'un hiç sorgulamadığı aralıkta kalır; pencere
sınırı olmasa ilk eksiksiz cron onları toptan iptal ederdi.

**3. Tek yokluk yetmez.** `ingest_watermark.cursor.lastCompleteRunAt` önceki **eksiksiz** koşunun
zamanını tutar; iptal eşiği bu koşu değil o zamandır. Etkinlik iki ardışık eksiksiz snapshot'ta
yoksa iptal edilir, ilk eksiksiz koşuda hiç iptal olmaz (`cancelled: null`), eksik koşu eşiği
ilerletmez. Ayrıca `unchanged` dalı `fetched_at`'i tazeler (yoksa hiç değişmeyen etkinlik iptal
edilirdi) ve iptal edilmiş bir etkinlik aynı payload'la geri gelirse durumu `confirmed`'a geri
çeker (`statusRestored`) — yoksa sonsuza kadar `cancelled` kalırdı.

Üç korumanın hepsi `pnpm test:pipeline` altında: 33 kontrol, ağ ve API key gerektirmiyor.

## Rotalar

| Rota | İşi |
|---|---|
| `/` | tanıtım + aktif bölgeler |
| `/me?u=<lastfm>&metro=<slug>&reach=<kademe>` | kişisel eşleşme listesi + yakınlık filtresi |
| `/metro/[slug]` | bölgedeki gelecek konserler |
| `/api/health` | şema hazırlık kontrolü; deploy sonrası doğrulama noktası |
| `/api/cron/ingest-events` | `vercel.json`: 6 saatte bir, 30 günlük dilimlerle |
| `/api/cron/refresh-taste` | `vercel.json`: günde bir |

## Yapı

```
migrations/0001_init.sql    docs/05 §1 DDL'inin birebir kopyası — ikisini birlikte güncelle
migrations/0002_home_location.sql  ev konumu kolonları + distance_m() + venue.country
src/lib/types.ts           paylaşılan sözleşme (EventSource, TasteSource, RawEvent, ...)
src/lib/db/client.ts       pool/sql/sqlOne/tx — DB erişimi yalnızca buradan
src/lib/http.ts            fetchJson: source_config'ten rate limit, throttle, cooldown
src/lib/source-config.ts   rate limitler koda gömülü değil, tablodan okunur
src/lib/sources/           lastfm, ticketmaster, musicbrainz adapter'ları
src/lib/matching.ts        5 kademeli sanatçı kimlik çözümlemesi + review kuyruğu
src/lib/scoring.ts         taste skorlama (log ölçek, recency decay, popülerlik cezası)
src/lib/ingest.ts          venue çözümleme, dedup_key, idempotent upsert
src/lib/pipeline.ts        refreshMetro: 30 günlük dilimler + eksik kümede iptal kapısı
src/lib/reach.ts           yakınlık kademeleri: eşikler, SQL parçaları, sınıflandırma
src/lib/geocode.ts         OSM Nominatim: adres -> koordinat
src/lib/edit-access.ts     GEÇİCİ: konum özelliği için secret + httpOnly cookie
src/lib/queries.ts         sayfaların okuma sorguları (reach filtresi dahil)
scripts/                   migrate, faz0, smoke, test-pagination, test-reach, check-*
```

## Deploy (Vercel)

**Sıra önemli: Vercel build'i migration ÇALIŞTIRMAZ.** Bilerek: build paralel ve tekrarlı
koşabilir, ayrıca build ortamının DB'ye erişimi garanti değil. Şemayı deploy'dan önce elle uygula,
yoksa uygulama runtime'da opak 500 verir.

```bash
vercel link

# 1. Neon'u Vercel Marketplace'ten ekle (DATABASE_URL otomatik gelir), sonra kalan env'leri gir
vercel env add LASTFM_API_KEY TICKETMASTER_API_KEY MUSICBRAINZ_USER_AGENT CRON_SECRET CONCERTIO_EDIT_SECRET

# 2. Şemayı Neon'a uygula — deploy'dan ÖNCE
vercel env pull .env.production.local --environment=production
pnpm db:migrate:prod

# 3. Yayına al
vercel deploy --prod

# 4. Şemanın hazır olduğunu teyit et
curl -s https://<proje>.vercel.app/api/health
```

`GET /api/health` şema hazırsa `200 {"ready":true}`, değilse `503` döner ve **eksik tabloların
adını** verir. Migration atlanmış bir deploy'da `/me` opak 500 verirken health endpoint
`missingTables` listesini gösterir — sorunu teşhis etmenin yolu burası.

Migration'lar sıfırdan idempotent çalışır (boş bir DB'de doğrulandı: 14 tablo, `norm_name` +
`distance_m`, 8 `home_*` kolonu, seed metro). `pnpm db:reset` yalnızca `localhost` bağlantısında
çalışır — prod şemasını düşürmesi mümkün değil.

Hobby planı ticari kullanıma kapalı; ürünleşecekse Pro şart (`docs/09-free-tier.md` §D).

## Attribution

Ticketmaster verisi gösteren her sayfada "Event data by Ticketmaster" ve bilet linkleri doğrudan
Ticketmaster'a gider. Zevk sinyali Last.fm'e, kimlik çözümlemesi MusicBrainz'e atıflı.
Detay: `docs/06-legal-and-tos.md`.
