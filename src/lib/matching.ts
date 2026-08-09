/**
 * Sanatci kimlik cozumlemesi — docs/05-architecture.md §2.2 boru hatti.
 *
 * Kademe tablosu ve esikler:
 * | Kademe | Yontem                                   | Esik                                  | Sonuc                                |
 * |--------|------------------------------------------|---------------------------------------|--------------------------------------|
 * | 0      | artist_external_id lookup                | —                                     | zaten bagli, oldugu gibi don         |
 * | 1      | MBID (girdi / reverseLookup / search)    | MB search: score>=95 + norm esitligi  | confidence=1.0, mb_url_rel           |
 * | 2      | exact norm (artist + artist_alias)       | tek aday                              | confidence=0.95, exact_norm          |
 * | 3      | trigram (GIN blocking: name_norm % $1)   | best>=0.90 VE ikinci<0.80             | confidence=similarity, trgm_auto     |
 * | 4      | belirsiz bolge                           | 0.75–0.90 veya marj dar               | match_review_queue, eslesme YOK      |
 * | 5      | aday yok                                 | best<0.75                             | yeni artist satiri (mbid NULL)       |
 *
 * Ek guard (docs/05 §2.2): norm uzunlugu<5 veya generic tek kelime -> fuzzy
 * auto-accept iptal, sadece MBID veya review.
 */
import { sql, sqlOne, tx } from '@/lib/db/client';
import { searchArtist, lookupUrlRels, reverseLookup } from '@/lib/sources/musicbrainz';
import type { ArtistResolution, MatchMethod, SourceId } from '@/lib/types';

/** Kademe 3 auto-accept alt siniri. */
const TRGM_AUTO_ACCEPT = 0.9;
/** Ikinci en iyi aday bunun ustundeyse marj dar sayilir -> review. */
const TRGM_RUNNERUP_MAX = 0.8;
/** Bunun altindaki benzerlik aday bile degildir -> yeni sanatci. */
const TRGM_REVIEW_MIN = 0.75;
/** MB search sonucunu MBID olarak kabul etmek icin minimum MB skoru. */
const MB_SEARCH_MIN_SCORE = 95;
/** Bu uzunlugun altindaki norm isimlerde fuzzy auto-accept yasak. */
const FUZZY_MIN_NORM_LENGTH = 5;
/** Sehir/jenerik tek kelime isimler: fuzzy auto-accept yasak (Boston problemi). */
const GENERIC_NAMES = new Set([
  'boston',
  'chicago',
  'america',
  'war',
  'live',
  'free',
  'genesis',
  'berlin',
  'europe',
  'asia',
  'kiss',
  'heart',
  'yes',
]);

interface ResolveInput {
  name: string;
  mbid?: string;
  externalIds?: Array<{ source: SourceId; id: string }>;
}

/** reverseLookup icin dis kimligi MB'nin tanidigi kanonik URL'ye cevirir. */
function externalIdToUrl(ext: { source: SourceId; id: string }): string | undefined {
  switch (ext.source) {
    case 'spotify':
      return `https://open.spotify.com/artist/${ext.id}`;
    case 'songkick':
      return `https://www.songkick.com/artists/${ext.id}`;
    case 'lastfm':
      return `https://www.last.fm/music/${ext.id}`;
    case 'ticketmaster':
      return `https://www.ticketmaster.com/artist/${ext.id}`;
    default:
      return undefined;
  }
}

const MATCH_METHODS: ReadonlySet<string> = new Set([
  'mb_url_rel',
  'exact_norm',
  'trgm_auto',
  'manual',
]);

async function linkExternalIds(
  q: typeof sql,
  artistId: string,
  externalIds: Array<{ source: SourceId; id: string }>,
  confidence: number,
  verifiedVia: MatchMethod,
): Promise<void> {
  for (const ext of externalIds) {
    await q(
      `INSERT INTO artist_external_id (artist_id, source, external_id, confidence, verified_via)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source, external_id) DO NOTHING`,
      [artistId, ext.source, ext.id, confidence, verifiedVia],
    );
  }
}

export async function resolveArtist(input: ResolveInput): Promise<ArtistResolution> {
  const externalIds = input.externalIds ?? [];

  // Kademe 0: dis kimlik zaten bagliysa dogrudan don.
  for (const ext of externalIds) {
    const linked = await sqlOne<{ artist_id: string; confidence: number; verified_via: string | null }>(
      `SELECT artist_id, confidence, verified_via FROM artist_external_id
       WHERE source = $1 AND external_id = $2`,
      [ext.source, ext.id],
    );
    if (linked) {
      return {
        artistId: linked.artist_id,
        confidence: linked.confidence,
        verifiedVia: (MATCH_METHODS.has(linked.verified_via ?? '')
          ? linked.verified_via
          : 'manual') as MatchMethod,
      };
    }
  }

  // Kademe 1: MBID bul — girdiden, reverseLookup'tan veya MB aramasindan.
  let mbid = input.mbid;
  if (!mbid) {
    for (const ext of externalIds) {
      const url = externalIdToUrl(ext);
      if (!url) continue;
      const hit = await reverseLookup(url);
      if (hit) {
        mbid = hit.mbid;
        break;
      }
    }
  }

  // Kademe 1.5: MB ARAMASINDAN ONCE lokal exact-norm kontrolu.
  // Docs'taki sira MB'yi one aliyor, cunku amac YENI sanatci icin MBID yakalamak.
  // Ama bu adi daha once cozdukse MB aramasi saf israf: her koşuda ayni agi
  // dovuyor ve 1 istek/sn limitinde 503 riski uretiyor (canli koşuda yasandi).
  // Bilinen ad -> Kademe 2'ye dus, ag yok.
  if (!mbid) {
    const known = await sqlOne<{ id: string }>(
      `SELECT a.id FROM artist a
        WHERE a.name_norm = norm_name($1)
          AND EXISTS (SELECT 1 FROM artist_external_id x WHERE x.artist_id = a.id)
        LIMIT 1`,
      [input.name],
    );
    if (known) {
      return { artistId: known.id, confidence: 0.95, verifiedVia: 'exact_norm' };
    }
  }
  if (!mbid) {
    // MB text aramasi fuzzy'dir; yalnizca cok yuksek skor + norm esitligi ile
    // kabul edilir (Nirvana UK/US tuzagini isimle secmemek icin, docs/05 §2.3).
    const results = await searchArtist(input.name);
    const top = results[0];
    if (top && top.score >= MB_SEARCH_MIN_SCORE) {
      const eq = await sqlOne<{ eq: boolean }>('SELECT norm_name($1) = norm_name($2) AS eq', [
        top.name,
        input.name,
      ]);
      if (eq?.eq) mbid = top.mbid;
    }
  }

  if (mbid) {
    const existing = await sqlOne<{ id: string }>('SELECT id FROM artist WHERE mbid = $1', [mbid]);
    if (existing) {
      return tx(async (q) => {
        await linkExternalIds(q, existing.id, externalIds, 1.0, 'mb_url_rel');
        return { artistId: existing.id, confidence: 1.0, verifiedVia: 'mb_url_rel' as const };
      });
    }
    // Yeni sanatci: MB kanonik adi + url-rel'lerden gelen TUM dis kimlikler.
    const rels = await lookupUrlRels(mbid);
    const merged = [...rels.externalIds];
    const seen = new Set(merged.map((e) => `${e.source}:${e.id}`));
    for (const ext of externalIds) {
      if (!seen.has(`${ext.source}:${ext.id}`)) merged.push(ext);
    }
    return tx(async (q) => {
      // Ayni norm'a sahip mbid'siz sanatci varsa yeni satir ACMA, onu benimse —
      // aksi halde onceden isimle yaratilmis satir (Kademe 5) kopyalanirdi.
      const adopted = await q<{ id: string }>(
        `UPDATE artist SET mbid = $1, name = $2, updated_at = now()
         WHERE id = (
           SELECT id FROM artist
           WHERE mbid IS NULL AND name_norm IN (norm_name($2), norm_name($3))
           ORDER BY created_at LIMIT 1
         )
         RETURNING id`,
        [mbid, rels.name, input.name],
      );
      let artistId = adopted[0]?.id;
      if (!artistId) {
        const rows = await q<{ id: string }>(
          `INSERT INTO artist (name, mbid) VALUES ($1, $2)
           ON CONFLICT (mbid) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [rels.name, mbid],
        );
        artistId = rows[0]!.id;
      }
      await linkExternalIds(q, artistId, merged, 1.0, 'mb_url_rel');
      // Girdi adi MB kanonik adindan farkliysa gozlenen varyant olarak sakla —
      // sonraki cagrilar Kademe 2'de yakalanir.
      await q(
        `INSERT INTO artist_alias (artist_id, alias, kind)
         SELECT $1, $2, 'observed'
         WHERE norm_name($2) <> norm_name($3)
         ON CONFLICT (artist_id, alias_norm) DO NOTHING`,
        [artistId, input.name, rels.name],
      );
      return { artistId, confidence: 1.0, verifiedVia: 'mb_url_rel' as const };
    });
  }

  // Kademe 2: exact norm match (artist.name_norm + artist_alias.alias_norm, btree).
  const exact = await sql<{ id: string; name: string }>(
    `SELECT DISTINCT a.id, a.name
     FROM artist a
     LEFT JOIN artist_alias al ON al.artist_id = a.id
     WHERE a.name_norm = norm_name($1) OR al.alias_norm = norm_name($1)`,
    [input.name],
  );
  if (exact.length === 1) {
    const artistId = exact[0]!.id;
    return tx(async (q) => {
      await linkExternalIds(q, artistId, externalIds, 0.95, 'exact_norm');
      return { artistId, confidence: 0.95, verifiedVia: 'exact_norm' as const };
    });
  }
  if (exact.length > 1) {
    // Ayni norm'a sahip birden fazla sanatci (ayni isimli iki grup) — isimle secilmez.
    return queueReview(input, exact.map((c) => ({ artistId: c.id, name: c.name, similarity: 1 })));
  }

  // Kademe 3: trigram. Blocking: `%` operatoru GIN indeksini kullanir.
  const candidates = await sql<{ id: string; name: string; sim: number }>(
    `SELECT id, name, max(sim) AS sim FROM (
       SELECT a.id, a.name, similarity(a.name_norm, norm_name($1)) AS sim
       FROM artist a WHERE a.name_norm % norm_name($1)
       UNION ALL
       SELECT a.id, a.name, similarity(al.alias_norm, norm_name($1)) AS sim
       FROM artist_alias al JOIN artist a ON a.id = al.artist_id
       WHERE al.alias_norm % norm_name($1)
     ) c
     GROUP BY id, name
     ORDER BY sim DESC
     LIMIT 5`,
    [input.name],
  );

  const norm = (await sqlOne<{ n: string }>('SELECT norm_name($1) AS n', [input.name]))?.n ?? '';
  const fuzzyGuard = norm.length < FUZZY_MIN_NORM_LENGTH || GENERIC_NAMES.has(norm);

  const best = candidates[0];
  const runnerUp = candidates[1];
  const reviewable = candidates.filter((c) => c.sim >= TRGM_REVIEW_MIN);

  if (best && best.sim >= TRGM_REVIEW_MIN) {
    const marginOk = !runnerUp || runnerUp.sim < TRGM_RUNNERUP_MAX;
    if (best.sim >= TRGM_AUTO_ACCEPT && marginOk && !fuzzyGuard) {
      const confidence = best.sim;
      return tx(async (q) => {
        await linkExternalIds(q, best.id, externalIds, confidence, 'trgm_auto');
        return { artistId: best.id, confidence, verifiedVia: 'trgm_auto' as const };
      });
    }
    // Kademe 4: 0.75-0.90 arasi, marj dar veya guard devrede -> insan karari.
    return queueReview(
      input,
      reviewable.map((c) => ({ artistId: c.id, name: c.name, similarity: c.sim })),
    );
  }

  // Kademe 5: hic aday yok -> yeni sanatci (mbid NULL).
  // verifiedVia='exact_norm', confidence=1.0: satir bu girdiden yaratildigi icin
  // isim kimligi insa geregi kesindir; 'manual' yanlis olurdu (insan bakmadi),
  // 'trgm_auto'/'mb_url_rel' ise hic yasanmamis bir yontemi iddia ederdi.
  return tx(async (q) => {
    const rows = await q<{ id: string }>('INSERT INTO artist (name) VALUES ($1) RETURNING id', [
      input.name,
    ]);
    const artistId = rows[0]!.id;
    await linkExternalIds(q, artistId, externalIds, 1.0, 'exact_norm');
    return { artistId, confidence: 1.0, verifiedVia: 'exact_norm' as const };
  });
}

/** match_review_queue'ya idempotent yazip ArtistMatchReview doner (Kademe 4). */
async function queueReview(
  input: ResolveInput,
  candidates: Array<{ artistId: string; name: string; similarity: number }>,
): Promise<ArtistResolution> {
  const first = input.externalIds?.[0];
  const leftRef = {
    source: first?.source ?? null,
    external_id: first?.id ?? null,
    name: input.name,
  };
  await tx(async (q) => {
    const pending = await q<{ id: string }>(
      `SELECT id FROM match_review_queue
       WHERE kind = 'artist_link' AND status = 'pending' AND left_ref->>'name' = $1`,
      [input.name],
    );
    if (pending.length === 0) {
      await q(
        `INSERT INTO match_review_queue (kind, left_ref, candidates)
         VALUES ('artist_link', $1::jsonb, $2::jsonb)`,
        [
          JSON.stringify(leftRef),
          JSON.stringify(
            candidates.map((c) => ({ artist_id: c.artistId, name: c.name, similarity: c.similarity })),
          ),
        ],
      );
    }
  });
  return { review: true, candidates };
}
