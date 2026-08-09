import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * GECICI ERISIM KONTROLU — Faz 0/1, auth gelene kadar.
 *
 * Uygulamada kullanici oturumu yok: `/me?u=<lastfm>` kimlik dogrulamaz, sadece
 * bir parametre ve Last.fm kullanici adlari zaten herkese acik. Eslesme listesi
 * public veri, ama EV ADRESI degil.
 *
 * Bu yuzden:
 *   - Konum ozelligi ancak `CONCERTIO_EDIT_SECRET` tanimliysa vardir (fail closed).
 *   - Hem OKUMA hem YAZMA bu secret'i bilmeyi gerektirir. Kullanici adini
 *     whitelist etmek yetmez: kullanici adi tahmin edilebilir, secret degil.
 *   - Secret bir kez dogrulaninca httpOnly cookie'ye yaziliyor; sonraki
 *     isteklerde tekrar yazmak gerekmiyor. Cookie'de secret'in kendisi degil
 *     sha256'si duruyor.
 *
 * Faz 1'de Auth.js gelince bu dosya silinir; sahiplik oturumdan okunur
 * (docs/07-roadmap-and-decisions.md Faz 1).
 */

const COOKIE_NAME = 'concertio_edit';

function expectedFingerprint(): string | undefined {
  const secret = process.env.CONCERTIO_EDIT_SECRET?.trim();
  if (!secret || secret.length < 16) return undefined;
  return createHash('sha256').update(secret).digest('hex');
}

/** Ozellik hic aktif mi (secret tanimli ve yeterince uzun mu). */
export function locationFeatureEnabled(): boolean {
  return expectedFingerprint() !== undefined;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual esit uzunluk ister; uzunluk farki zaten esitsizlik demek.
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Gonderilen secret dogru mu. Yanlissa cookie yazilmaz. */
export function verifySecret(input: string | undefined): boolean {
  const secret = process.env.CONCERTIO_EDIT_SECRET?.trim();
  if (!secret || !input) return false;
  return sameSecret(secret, input.trim());
}

/** Cagiran daha once dogrulanmis mi (cookie parmak izi tutuyor mu). */
export async function hasEditAccess(): Promise<boolean> {
  const expected = expectedFingerprint();
  if (!expected) return false;
  const jar = await cookies();
  const value = jar.get(COOKIE_NAME)?.value;
  return value !== undefined && sameSecret(expected, value);
}

/** Dogrulama sonrasi cookie yazar. httpOnly: JS okuyamaz. */
export async function grantEditAccess(): Promise<void> {
  const expected = expectedFingerprint();
  if (!expected) return;
  const jar = await cookies();
  jar.set(COOKIE_NAME, expected, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}
