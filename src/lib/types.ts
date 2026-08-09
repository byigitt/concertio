/**
 * Paylasilan veri modeli. docs/05-architecture.md §1 (Postgres DDL) ve §8.3
 * (`EventSource` arayuzu) ile birebir eslesir; birini degistirirken digerini de guncelle.
 */

export type SourceId =
  | 'ticketmaster'
  | 'seatgeek'
  | 'songkick'
  | 'lastfm'
  | 'spotify'
  | 'musicbrainz';

export type TasteSignal =
  | 'lastfm_top'
  | 'lastfm_loved'
  | 'lastfm_recent'
  | 'spotify_top'
  | 'spotify_recent'
  | 'spotify_followed';

export type Billing = 'headliner' | 'support';

export type EventStatus = 'confirmed' | 'cancelled' | 'postponed';

/** Bir kaynagin bize verdigi sanatci; DB'ye yazilmadan once kimlik cozumlemesinden gecer. */
export interface RawArtist {
  name: string;
  /** Kaynagin kendi id'si — artist_external_id.external_id olur. */
  externalId?: string;
  mbid?: string;
  billing?: Billing;
  position?: number;
}

export interface RawVenue {
  name: string;
  lat?: number;
  lng?: number;
  city?: string;
  state?: string;
}

export interface RawTicketUrl {
  source: SourceId;
  url: string;
  priceMin?: number;
  priceMax?: number;
}

/** Kaynak-agnostik etkinlik. Her adapter bunu dondurur; normalize/dedupe sonrasi `event` olur. */
export interface RawEvent {
  source: SourceId;
  /** Kaynagin kendi event id'si. `unique(source, source_id)` anahtarinin ikinci yarisi. */
  sourceId: string;
  title?: string;
  /** ISO 8601. Saat bilinmiyorsa gunun basi. */
  startsAt: string;
  endsAt?: string;
  status: EventStatus;
  venue: RawVenue;
  artists: RawArtist[];
  ticketUrls: RawTicketUrl[];
  /** Ham API cevabi — event_source_record.payload'a gider, asla silinmez. */
  payload: unknown;
}

/** Bir kullanicinin tek bir sanatciya dair ham zevk sinyali (skorlama oncesi). */
export interface RawTasteSignal {
  artistName: string;
  mbid?: string;
  signal: TasteSignal;
  /** Sinyale gore anlami degisir: playcount, loved sirasi, recent tekrar sayisi. */
  weight: number;
  /** lastfm_recent icin son calma zamani (ISO); recency decay'de kullanilir. */
  lastPlayedAt?: string;
  /** Populerlik normalizasyonu icin (docs/05 §3). */
  listenersGlobal?: number;
}

export interface SourceLimits {
  requestsPerSecond: number;
  dailyQuota?: number;
  throttleMs?: number;
  /** Bu HTTP kodlari gorulurse kaynagin TAMAMI gecici kapatilir (docs/05 §pipeline). */
  cooldownOnStatuses?: number[];
}

export interface EventQuery {
  /** Sanatci-first sorgu (docs/07 K-4): kaynagin kendi attraction/artist id'si. */
  artistExternalId?: string;
  artistName?: string;
  artistMbid?: string;
  /** Metro-first sorgu. Kaynagin kendi metro/DMA id'si. */
  metroSourceId?: string;
  startsAfter?: Date;
  startsBefore?: Date;
}

/**
 * Cekim sonucu. `complete=false` demek: kaynak sonuclari KIRPTI (Ticketmaster'in
 * `size*page < 1000` deep-paging tavani gibi), yani bu sorgunun tam kumesi elde
 * degil. Cagiran taraf bu durumda ASLA "gelmeyen etkinlik iptal edilmis olmali"
 * cikarimi yapmamali — `markStaleCancelled` atlanir, tarih penceresi bolunup
 * yeniden cekilir. Aksi halde yogun bir DMA'da onceki sayfalardaki gercek
 * etkinlikler yanlislikla iptal isaretlenir.
 */
export interface EventFetchResult {
  events: RawEvent[];
  complete: boolean;
  /** Kaynagin bildirdigi toplam sonuc sayisi (varsa) — kirpma miktarini loglamak icin. */
  totalAvailable?: number;
}

export interface EventSource {
  /** event_source_record.source ile birebir. */
  readonly id: SourceId;
  readonly limits: SourceLimits;
  /** Kaynak yapilandirilmis mi (API key var mi). Yoksa pipeline bu kaynagi atlar. */
  isConfigured(): boolean;
  /** Sanatci adini kaynagin kendi id'sine cevirir; desteklemiyorsa undefined. */
  resolveArtist?(name: string): Promise<string | undefined>;
  fetchEvents(query: EventQuery): Promise<EventFetchResult>;
}

export interface TasteSource {
  readonly id: SourceId;
  readonly limits: SourceLimits;
  isConfigured(): boolean;
  fetchTaste(handle: string): Promise<RawTasteSignal[]>;
}

/** Kimlik cozumlemesi sonucu (docs/07 K-3: url-rel varsa kesin, yoksa kontrollu fuzzy). */
export type MatchMethod = 'mb_url_rel' | 'exact_norm' | 'trgm_auto' | 'manual';

export interface ArtistMatch {
  artistId: string;
  confidence: number;
  verifiedVia: MatchMethod;
}

export interface ArtistMatchReview {
  /** Eslesme yapilmadi; match_review_queue'ya dusuruldu. */
  review: true;
  candidates: Array<{ artistId: string; name: string; similarity: number }>;
}

export type ArtistResolution = ArtistMatch | ArtistMatchReview;

export function isReview(r: ArtistResolution): r is ArtistMatchReview {
  return 'review' in r;
}
