import { sql, sqlOne } from '@/lib/db/client';
import { ingestEvents, markStaleCancelled } from '@/lib/ingest';
import type { EventSource } from '@/lib/types';

/**
 * Metro-first etkinlik yenileme. Cron route'undan ayri duruyor ki kaynak
 * enjekte edilip test edilebilsin (route sadece yetki + HTTP cevabi yapar).
 */

/** Tek sorgunun tarih genisligi. Dar dilim = deep-paging tavanina carpma riski dusuk. */
export const CHUNK_DAYS = 30;
/** Toplam pencere: 3 x 30 = 90 gun ileri. */
export const WINDOW_CHUNKS = 3;

export interface MetroRef {
  id: string;
  slug: string;
  source_id: string;
}

export interface MetroRefreshResult {
  metro: string;
  seen: number;
  unchanged: number;
  eventsInserted: number;
  eventsUpdated: number;
  artistsReviewed: number;
  /** Iptal edilmisken geri gelip durumu duzeltilen etkinlik sayisi. */
  statusRestored: number;
  /** Tum dilimler eksiksiz mi cekildi. false ise stale-cancel ATLANIR. */
  complete: boolean;
  totalAvailable: number;
  /**
   * Iptal edilen etkinlik sayisi. `null` = iptal taramasi HIC calismadi:
   * ya kume eksik (`complete=false`) ya da bu metro icin henuz bir onceki
   * eksiksiz koşu yok (ilk kez gorulen etkinlikler icin "kayboldu" denemez).
   */
  cancelled: number | null;
  /** Karsilastirmada kullanilan onceki eksiksiz koşunun zamani. */
  comparedAgainst: string | null;
}

interface WatermarkCursor {
  complete?: boolean;
  totalAvailable?: number;
  /** En son EKSIKSIZ koşunun baslangici. Eksik koşular bunu guncellemez. */
  lastCompleteRunAt?: string;
}

export async function refreshMetro(
  source: EventSource,
  metro: MetroRef,
  startedAt: Date,
): Promise<MetroRefreshResult> {
  let complete = true;
  let totalAvailable = 0;
  const totals = {
    seen: 0,
    unchanged: 0,
    eventsInserted: 0,
    eventsUpdated: 0,
    artistsReviewed: 0,
    statusRestored: 0,
  };

  // Onceki EKSIKSIZ koşunun zamani. Iptal karari buna gore veriliyor:
  // bir etkinlik ancak o koşudan beri hic gorulmediyse (yani iki ardisik
  // eksiksiz snapshot'ta yok) iptal edilir — docs/05 §4 "2 ardisik koşu".
  const previous = await sqlOne<{ cursor: WatermarkCursor }>(
    'SELECT cursor FROM ingest_watermark WHERE source = $1 AND scope = $2',
    [source.id, metro.slug],
  );
  const lastCompleteRunAt = previous?.cursor.lastCompleteRunAt;

  // Pencere 30 gunluk dilimlere bolunur (docs/05 §5.2): tek 90 gunluk sorgu
  // yogun bir DMA'da deep-paging tavanina carpiyor.
  for (let chunk = 0; chunk < WINDOW_CHUNKS; chunk += 1) {
    const from = new Date(startedAt.getTime() + chunk * CHUNK_DAYS * 86_400_000);
    const to = new Date(from.getTime() + CHUNK_DAYS * 86_400_000);
    const fetched = await source.fetchEvents({
      metroSourceId: metro.source_id,
      startsAfter: from,
      startsBefore: to,
    });
    if (!fetched.complete) complete = false;
    totalAvailable += fetched.totalAvailable ?? 0;
    const outcome = await ingestEvents(fetched.events, metro.id);
    totals.seen += outcome.seen;
    totals.unchanged += outcome.unchanged;
    totals.eventsInserted += outcome.eventsInserted;
    totals.eventsUpdated += outcome.eventsUpdated;
    totals.artistsReviewed += outcome.artistsReviewed;
    totals.statusRestored += outcome.statusRestored;
  }

  // Iptal taramasinin UC korumasi:
  //  1. Kume eksikse (`complete=false`) hic calismaz — cekilemeyen sayfalardaki
  //     gercek etkinlikler "gelmedi, demek iptal" sanilmasin.
  //  2. Yalnizca cektigimiz pencereyi tarar. faz0 daha uzun bir pencere
  //     (varsayilan 180 gun) ingest ediyor; 90 gunun otesini hic sorgulamadik.
  //  3. Tek yokluk yetmez: karsilastirma esigi BU koşu degil, onceki EKSIKSIZ
  //     koşu. Boylece etkinlik iki ardisik eksiksiz snapshot'ta yoksa iptal olur.
  //     Ilk eksiksiz koşuda esik olmadigi icin iptal calismaz.
  //  4. Yalnizca BU kaynagin gordugu etkinlikler aday. Ticketmaster taramasi
  //     SeatGeek-only bir etkinlige dokunamaz.
  const windowEnd = new Date(startedAt.getTime() + WINDOW_CHUNKS * CHUNK_DAYS * 86_400_000);
  const cancelled =
    complete && lastCompleteRunAt
      ? await markStaleCancelled(metro.id, source.id, new Date(lastCompleteRunAt), windowEnd)
      : null;

  const cursor: WatermarkCursor = {
    complete,
    totalAvailable,
    // Eksik koşu esigi ILERLETMEZ: yoksa eksik bir koşu "gordum" sayilip
    // sonraki eksiksiz koşu tek yoklukla iptale gecerdi.
    lastCompleteRunAt: complete ? startedAt.toISOString() : lastCompleteRunAt,
  };
  await sql(
    `INSERT INTO ingest_watermark (source, scope, cursor, last_success, error_count)
     VALUES ($1, $2, $3, now(), 0)
     ON CONFLICT (source, scope)
     DO UPDATE SET cursor = $3, last_success = now(), error_count = 0, last_error = NULL`,
    [source.id, metro.slug, JSON.stringify(cursor)],
  );

  return {
    metro: metro.slug,
    ...totals,
    complete,
    totalAvailable,
    cancelled,
    comparedAgainst: lastCompleteRunAt ?? null,
  };
}

export async function recordMetroFailure(
  sourceId: string,
  metroSlug: string,
  message: string,
): Promise<void> {
  await sql(
    `INSERT INTO ingest_watermark (source, scope, last_error, error_count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (source, scope)
     DO UPDATE SET last_error = $3, error_count = ingest_watermark.error_count + 1`,
    [sourceId, metroSlug, message],
  );
}
