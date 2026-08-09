/**
 * Yakinlik (reach) kademeleri: kullanicinin evine gore bir konserin "ne kadar
 * ulasilabilir" oldugunu siniflar.
 *
 * DURUSTLUK NOTU: mesafe duz hat (great-circle) mesafesidir, rota mesafesi degil.
 * Gercek toplu tasima rotasi hesaplamiyoruz (bunun icin GTFS/OTP gerekir), o
 * yuzden kademe isimleri iddia degil TAHMIN: `walk` "2 km icinde" demektir,
 * "yurunebilir" garantisi degil. Koy arasi 2 km ile sehir merkezinde 2 km ayni
 * sey degil; kullaniciya mesafeyi de gosteriyoruz ki kendi karari verebilsin.
 */

export const REACH_ORDER = ['walk', 'transit', 'city', 'daytrip', 'country', 'all'] as const;

export type Reach = (typeof REACH_ORDER)[number];

/** Yurume: 2 km. Ortalama 4-5 km/sa hizda ~25 dk. */
const WALK_METERS = 2_000;
/** Toplu tasima: 15 km. Sehir ici otobus/metro ile makul tek yon. */
const TRANSIT_METERS = 15_000;
/**
 * Gun donusu: 150 km. Sehirlerarasi otobus/tren ile gidip ayni gece donulebilir.
 * Kalibrasyon: SF -> Sacramento 120 km ve Capitol Corridor treniyle ~2 saat, yani
 * tipik bir gun donusu; 120 km esigi bunu DISARIDA birakiyordu.
 */
const DAYTRIP_METERS = 150_000;

export interface ReachTier {
  /** Kullaniciya gosterilen etiket (ingilizce, kucuk harf). */
  label: string;
  /** Kisa aciklama; filtre secenegi altinda gosterilir. */
  hint: string;
}

export const REACH_TIERS: Record<Reach, ReachTier> = {
  walk: { label: 'walking', hint: `within ${WALK_METERS / 1000} km of home` },
  transit: { label: 'transit', hint: `within ${TRANSIT_METERS / 1000} km of home` },
  city: { label: 'same city', hint: 'in the same city as home' },
  daytrip: { label: 'day trip', hint: `within ${DAYTRIP_METERS / 1000} km of home` },
  country: { label: 'same country', hint: 'different city, same country' },
  all: { label: 'anywhere', hint: 'no distance filter' },
};

export function isReach(value: string | undefined): value is Reach {
  return value !== undefined && (REACH_ORDER as readonly string[]).includes(value);
}

/**
 * SQL parcalari. Parametre sirasi cagiran tarafta sabit:
 * `$1` lastfm kullanici adi, `$2` ev enlem, `$3` ev boylam, `$4` ev sehir,
 * `$5` ev ulke, `$6` metro slug (nullable).
 *
 * Parametreler acikca cast edilir: Postgres `$5 IS NOT NULL` gibi baglamlarda
 * tipi cikaramiyor ve "could not determine data type of parameter" veriyor.
 */
const HOME_LAT = '$2::double precision';
const HOME_LNG = '$3::double precision';
const HOME_CITY = '$4::text';
const HOME_COUNTRY = '$5::text';
const DIST = `distance_m(${HOME_LAT}, ${HOME_LNG}, v.lat, v.lng)`;
const SAME_CITY = `(${HOME_CITY} IS NOT NULL AND norm_name(COALESCE(v.city, '')) = norm_name(${HOME_CITY}))`;
const SAME_COUNTRY = `(v.country IS NOT NULL AND ${HOME_COUNTRY} IS NOT NULL AND v.country = ${HOME_COUNTRY})`;

export const REACH_SELECT_SQL = `
  ${DIST} AS distance_m,
  ${SAME_CITY} AS same_city,
  ${SAME_COUNTRY} AS same_country
`;

/**
 * Secilen kademe icin WHERE yuklemi. Ev konumu yoksa cagiran taraf bunu hic
 * kullanmamali (filtre uygulanamaz, `all` gibi davranir).
 *
 * Kademeler KUMULATIF degil, bagimsiz yuklem: `city` seceni ayni sehirdeki her
 * seyi getirir (mesafesi 20 km olsa da), `transit` ise sehir sinirina bakmadan
 * 15 km icini getirir. Ikisini birlestirmek yerine ayri tutmak daha anlasilir.
 */
export function reachWhereSql(reach: Reach): string | undefined {
  switch (reach) {
    case 'walk':
      return `${DIST} <= ${WALK_METERS}`;
    case 'transit':
      return `${DIST} <= ${TRANSIT_METERS}`;
    case 'city':
      return `${SAME_CITY} OR ${DIST} <= ${TRANSIT_METERS}`;
    case 'daytrip':
      return `${DIST} <= ${DAYTRIP_METERS}`;
    case 'country':
      return SAME_COUNTRY;
    case 'all':
      return undefined;
  }
}

/**
 * Bir satirin gosterilecek en dar kademesi. Filtreden bagimsiz: kullanici
 * "gun donusu" secse bile yurume mesafesindeki konser `walk` etiketi alir.
 */
export function classifyReach(
  distanceMeters: number | null,
  sameCity: boolean,
  sameCountry: boolean,
): Reach {
  if (distanceMeters !== null) {
    if (distanceMeters <= WALK_METERS) return 'walk';
    if (distanceMeters <= TRANSIT_METERS) return 'transit';
    if (sameCity) return 'city';
    if (distanceMeters <= DAYTRIP_METERS) return 'daytrip';
  } else if (sameCity) {
    return 'city';
  }
  return sameCountry ? 'country' : 'all';
}

/** Mesafeyi kullaniciya gosterilebilir hale getirir. */
export function formatDistance(meters: number | null): string | undefined {
  if (meters === null) return undefined;
  if (meters < 1000) return `${Math.round(meters / 100) * 100} m`;
  if (meters < 10_000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}
