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

## Komutlar

```bash
pnpm smoke          # API key GEREKTİRMEZ — ingest/dedup/eşleme/sorgu zincirini fixture ile doğrular
pnpm test:pipeline  # API key ve ağ GEREKTİRMEZ — sayfalama tavanı + iptal kapısı testleri
pnpm check:lastfm   # canlı Last.fm kontrolü: sinyal sayısı + MBID doluluk oranı
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

Üç korumanın hepsi `pnpm test:pipeline` altında: 30 kontrol, ağ ve API key gerektirmiyor.

## Rotalar

| Rota | İşi |
|---|---|
| `/` | tanıtım + aktif bölgeler |
| `/me?u=<lastfm>&metro=<slug>` | kişisel eşleşme listesi |
| `/metro/[slug]` | bölgedeki gelecek konserler |
| `/api/cron/ingest-events` | `vercel.json`: 6 saatte bir, 30 günlük dilimlerle |
| `/api/cron/refresh-taste` | `vercel.json`: günde bir |

## Yapı

```
migrations/0001_init.sql   docs/05 §1 DDL'inin birebir kopyası — ikisini birlikte güncelle
src/lib/types.ts           paylaşılan sözleşme (EventSource, TasteSource, RawEvent, ...)
src/lib/db/client.ts       pool/sql/sqlOne/tx — DB erişimi yalnızca buradan
src/lib/http.ts            fetchJson: source_config'ten rate limit, throttle, cooldown
src/lib/source-config.ts   rate limitler koda gömülü değil, tablodan okunur
src/lib/sources/           lastfm, ticketmaster, musicbrainz adapter'ları
src/lib/matching.ts        5 kademeli sanatçı kimlik çözümlemesi + review kuyruğu
src/lib/scoring.ts         taste skorlama (log ölçek, recency decay, popülerlik cezası)
src/lib/ingest.ts          venue çözümleme, dedup_key, idempotent upsert
src/lib/pipeline.ts        refreshMetro: 30 günlük dilimler + eksik kümede iptal kapısı
scripts/                   migrate, faz0, smoke, test-pagination
```

## Deploy (Vercel)

```bash
vercel link
vercel env add DATABASE_URL LASTFM_API_KEY TICKETMASTER_API_KEY MUSICBRAINZ_USER_AGENT CRON_SECRET
vercel deploy --prod
```

Hobby planı ticari kullanıma kapalı; ürünleşecekse Pro şart (`docs/09-free-tier.md` §D).
Neon'u Vercel Marketplace üzerinden ekleyince `DATABASE_URL` otomatik gelir.

## Attribution

Ticketmaster verisi gösteren her sayfada "Event data by Ticketmaster" ve bilet linkleri doğrudan
Ticketmaster'a gider. Zevk sinyali Last.fm'e, kimlik çözümlemesi MusicBrainz'e atıflı.
Detay: `docs/06-legal-and-tos.md`.
