import { z } from 'zod';
import { fetchJson } from '@/lib/http';

/**
 * OSM Nominatim ile adres -> koordinat cozumleme.
 *
 * Kullanim sartlari (https://operations.osmfoundation.org/policies/nominatim/):
 *   - En fazla 1 istek/sn  -> `source_config` satirindan uygulaniyor.
 *   - Anlamli User-Agent   -> `fetchJson` gonderiyor (MUSICBRAINZ_USER_AGENT).
 *   - Sonuclari cache'le   -> `app_user.home_lat/lng` kalici olarak saklanir,
 *     yani kullanici basina tek istek yetiyor.
 *   - Ciddi hacimde kendi Nominatim sunucunu kur (Faz 2 notu).
 */

const nominatimResultSchema = z.object({
  lat: z.coerce.number(),
  lon: z.coerce.number(),
  display_name: z.string(),
  address: z
    .object({
      city: z.string().optional(),
      town: z.string().optional(),
      village: z.string().optional(),
      municipality: z.string().optional(),
      state: z.string().optional(),
      country_code: z.string().optional(),
    })
    .optional(),
});

const nominatimResponseSchema = z.array(nominatimResultSchema);

export interface GeocodedPlace {
  label: string;
  lat: number;
  lng: number;
  city?: string;
  state?: string;
  /** ISO 3166-1 alpha-2, buyuk harf ('US'). venue.country ile karsilastirilir. */
  country?: string;
}

/**
 * Serbest metin adresi tek bir yere cozer. Bulamazsa `undefined`.
 * Cagiran taraf sonucu MUTLAKA kullaniciya gosterip onaylatmali: "New York"
 * gibi girdiler beklenmedik bir yere dusebilir ve sessizce yanlis konum
 * butun yakinlik filtresini bozar.
 */
export async function geocode(query: string): Promise<GeocodedPlace | undefined> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return undefined;

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', trimmed);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '1');

  const results = await fetchJson(url.toString(), nominatimResponseSchema, {
    source: 'nominatim',
  });
  const hit = results[0];
  if (!hit) return undefined;

  const address = hit.address;
  return {
    label: hit.display_name,
    lat: hit.lat,
    lng: hit.lon,
    city: address?.city ?? address?.town ?? address?.village ?? address?.municipality,
    state: address?.state,
    country: address?.country_code?.toUpperCase(),
  };
}
