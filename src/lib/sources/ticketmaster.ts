import { z } from 'zod';
import { fetchJson } from '@/lib/http';
import type {
  EventFetchResult,
  EventQuery,
  EventSource,
  EventStatus,
  RawArtist,
  RawEvent,
  RawTicketUrl,
  RawVenue,
} from '@/lib/types';

/**
 * Ticketmaster Discovery API v2 adapter'i (docs/04 "Ticketmaster Discovery" bolumu).
 * Birincil yol artist-first crawl (docs/07 K-4): attractionId ile sanatcinin her yerdeki
 * takvimi tek sorguda gelir; metro-first (dmaId) yalnizca kesif/yedek yoldur.
 */

const ROOT = 'https://app.ticketmaster.com/discovery/v2/';

/** Tek sayfada istenen kayit sayisi. Deep-paging tavani: size * page < 1000 (docs/04 §tablo). */
const PAGE_SIZE = 100;
const DEEP_PAGING_CAP = 1000;

// --- Zod semalari -----------------------------------------------------------
// Ticketmaster cevabinda opsiyonel alan cok; yalnizca event.id ve dates.start zorunlu.

const tmExternalLinkSchema = z.object({
  url: z.string().optional(),
  id: z.string().optional(),
});

/**
 * externalLinks dinamik bir nesnedir (saglayici adi -> link dizisi). `musicbrainz`
 * anahtarinin varligi Ticketmaster Discovery docs'undaki attraction ornek
 * payload'inda dogrulandi: externalLinks.musicbrainz[0].id MBID'dir
 * (ör. "cc197bad-dc9c-440d-a5b5-d52ba2e14234"). Her attraction'da bulunmaz,
 * o yuzden tamamen opsiyonel.
 */
const tmAttractionSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  externalLinks: z
    .object({ musicbrainz: z.array(tmExternalLinkSchema).optional() })
    .loose()
    .optional(),
});

const tmVenueSchema = z.object({
  name: z.string().optional(),
  city: z.object({ name: z.string().optional() }).optional(),
  state: z.object({ stateCode: z.string().optional() }).optional(),
  // Discovery API koordinatlari STRING dondurur; coerce ile sayiya cevrilir.
  location: z
    .object({
      latitude: z.coerce.number().optional(),
      longitude: z.coerce.number().optional(),
    })
    .optional(),
});

/** Export: fixture dogrulamasi ve olasi cok-kaynakli testler icin. */
export const tmEventSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  url: z.string().optional(),
  dates: z.object({
    start: z.object({
      dateTime: z.string().optional(),
      localDate: z.string().optional(),
      localTime: z.string().optional(),
    }),
    status: z.object({ code: z.string().optional() }).optional(),
  }),
  priceRanges: z
    .array(z.object({ min: z.number().optional(), max: z.number().optional() }))
    .optional(),
  _embedded: z
    .object({
      venues: z.array(tmVenueSchema).optional(),
      attractions: z.array(tmAttractionSchema).optional(),
    })
    .optional(),
});

/** Export: fixture dogrulamasi icin — fetchEvents sayfalari bu semadan gecirir. */
export const tmEventsPageSchema = z.object({
  _embedded: z.object({ events: z.array(tmEventSchema) }).optional(),
  page: z.object({
    size: z.number(),
    totalElements: z.number(),
    totalPages: z.number(),
    number: z.number(),
  }),
});

const tmAttractionsPageSchema = z.object({
  _embedded: z.object({ attractions: z.array(tmAttractionSchema) }).optional(),
});

type TmEvent = z.infer<typeof tmEventSchema>;

// --- Yardimcilar --------------------------------------------------------------

/**
 * DB'deki norm_name() ile ayni ruhta isim normalizasyonu: kucuk harf, aksan
 * temizligi, alfasayisal disi karakterlerin atilmasi. resolveArtist'te aday
 * dogrulamasi icin kullanilir (yanlis attraction id tum ingest'i kirletir).
 */
function normName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** ISO 8601, saniye hassasiyeti, Z sonekli — Ticketmaster milisaniyeyi kabul etmez. */
function toTmDateTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function toStatus(code: string | undefined): EventStatus {
  switch (code) {
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'postponed':
    case 'rescheduled':
      return 'postponed';
    default:
      // onsale/offsale ve bilinmeyen kodlar: etkinlik takvimde, confirmed sayilir.
      return 'confirmed';
  }
}

/** dateTime > localDate+localTime > localDate gun basi (docs/05 RawEvent.startsAt kurali). */
function toStartsAt(event: TmEvent): string | undefined {
  const { dateTime, localDate, localTime } = event.dates.start;
  if (dateTime) return dateTime;
  if (localDate && localTime) return `${localDate}T${localTime}`;
  if (localDate) return `${localDate}T00:00:00`;
  return undefined;
}

/** Export: fixture dogrulamasi icin — fetchEvents ayni fonksiyonu kullanir. */
export function toRawEvent(event: TmEvent): RawEvent | undefined {
  const startsAt = toStartsAt(event);
  if (!startsAt) {
    // dates.start zorunlu ama icindeki tum alanlar bos olabilir; tarihsiz etkinlik ise yaramaz.
    console.warn(`ticketmaster: tarihsiz etkinlik atlandi: ${event.id}`);
    return undefined;
  }

  const tmVenue = event._embedded?.venues?.[0];
  const venue: RawVenue = { name: tmVenue?.name ?? '' };
  if (tmVenue?.location?.latitude !== undefined) venue.lat = tmVenue.location.latitude;
  if (tmVenue?.location?.longitude !== undefined) venue.lng = tmVenue.location.longitude;
  if (tmVenue?.city?.name) venue.city = tmVenue.city.name;
  if (tmVenue?.state?.stateCode) venue.state = tmVenue.state.stateCode;

  const artists: RawArtist[] = [];
  for (const [i, attraction] of (event._embedded?.attractions ?? []).entries()) {
    if (!attraction.name) continue;
    const artist: RawArtist = {
      name: attraction.name,
      externalId: attraction.id,
      // Ilk siradaki attraction headliner kabul edilir (Discovery API siralama garantisi).
      billing: i === 0 ? 'headliner' : 'support',
      position: i,
    };
    const mbid = attraction.externalLinks?.musicbrainz?.[0]?.id;
    if (mbid) artist.mbid = mbid;
    artists.push(artist);
  }

  const ticketUrls: RawTicketUrl[] = [];
  if (event.url) {
    const ticketUrl: RawTicketUrl = { source: 'ticketmaster', url: event.url };
    const price = event.priceRanges?.[0];
    if (price?.min !== undefined) ticketUrl.priceMin = price.min;
    if (price?.max !== undefined) ticketUrl.priceMax = price.max;
    ticketUrls.push(ticketUrl);
  }

  const raw: RawEvent = {
    source: 'ticketmaster',
    sourceId: event.id,
    startsAt,
    status: toStatus(event.dates.status?.code),
    venue,
    artists,
    ticketUrls,
    payload: event,
  };
  if (event.name) raw.title = event.name;
  return raw;
}

function apiUrl(path: string, params: Record<string, string>): string {
  const key = process.env['TICKETMASTER_API_KEY'];
  if (!key) {
    throw new Error('ticketmaster: TICKETMASTER_API_KEY yok; isConfigured() kontrol edilmeliydi');
  }
  const url = new URL(path, ROOT);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set('apikey', key);
  return url.toString();
}

// --- Adapter -----------------------------------------------------------------

export const ticketmaster: EventSource = {
  id: 'ticketmaster',

  // Baslangic limitleri (docs/05 §5.1); runtime'da source_config tablosu onceliklidir,
  // fetchJson throttle'i oradan okur (K-5).
  limits: {
    requestsPerSecond: 4,
    dailyQuota: 4500,
    throttleMs: 0,
    cooldownOnStatuses: [429, 406, 503],
  },

  isConfigured() {
    return Boolean(process.env['TICKETMASTER_API_KEY']);
  },

  async resolveArtist(name) {
    const url = apiUrl('attractions.json', {
      keyword: name,
      classificationName: 'music',
      size: '5',
    });
    const page = await fetchJson(url, tmAttractionsPageSchema, { source: 'ticketmaster' });
    const wanted = normName(name);
    for (const candidate of page._embedded?.attractions ?? []) {
      // Yalnizca normalize edilmis isim birebir tutarsa kabul; zayif eslesme
      // yanlis attraction id'siyle tum ingest'i kirletir, sessizce kabul edilmez.
      if (candidate.name && normName(candidate.name) === wanted) {
        return candidate.id;
      }
    }
    return undefined;
  },

  async fetchEvents(query: EventQuery): Promise<EventFetchResult> {
    const params: Record<string, string> = {
      classificationName: 'music',
      size: String(PAGE_SIZE),
      sort: 'date,asc',
    };
    if (query.artistExternalId) {
      // Birincil yol: artist-first (K-4). Cografyaya degil sanatciya gore boler.
      params['attractionId'] = query.artistExternalId;
    } else if (query.metroSourceId) {
      // Yedek yol: metro-first, metro_area.source_id bir Ticketmaster DMA id'sidir.
      params['dmaId'] = query.metroSourceId;
    } else {
      throw new Error('ticketmaster: fetchEvents artistExternalId veya metroSourceId ister');
    }
    if (query.startsAfter) params['startDateTime'] = toTmDateTime(query.startsAfter);
    if (query.startsBefore) params['endDateTime'] = toTmDateTime(query.startsBefore);

    const events: RawEvent[] = [];
    let pageNumber = 0;
    let complete = true;
    let totalAvailable: number | undefined;
    for (;;) {
      const page = await fetchJson(
        apiUrl('events.json', { ...params, page: String(pageNumber) }),
        tmEventsPageSchema,
        { source: 'ticketmaster' },
      );
      totalAvailable = page.page.totalElements;
      for (const event of page._embedded?.events ?? []) {
        const raw = toRawEvent(event);
        if (raw) {
          events.push(raw);
        } else {
          // Cevrilemeyen kayit da kumeyi eksik yapar: o etkinlik daha once
          // ingest edilmis olabilir ve `complete=true` dersek stale-cancel onu
          // yanlislikla iptal eder. Kirpma degil ama sonuc ayni: kume tam degil.
          complete = false;
        }
      }
      const nextPage = page.page.number + 1;
      if (nextPage >= page.page.totalPages) break;
      // Deep-paging tavani: Ticketmaster size * page >= 1000 istekleri reddeder.
      // Burada kirpiyoruz, ama sessizce degil: `complete=false` ile cagirana
      // "bu kume eksik" diyoruz ki stale-cancel gibi cikarimlar yapmasin.
      if (PAGE_SIZE * nextPage >= DEEP_PAGING_CAP) {
        complete = false;
        console.warn(
          `ticketmaster: deep-paging tavani (${DEEP_PAGING_CAP}) asildi — ` +
            `${page.page.totalElements} sonucun ilk ${events.length} tanesi alindi. ` +
            'Tarih penceresini bolun (startsAfter/startsBefore ile daha dar sorgular).',
        );
        break;
      }
      pageNumber = nextPage;
    }
    return { events, complete, totalAvailable };
  },
};
