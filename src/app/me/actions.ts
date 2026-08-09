'use server';

import { revalidatePath } from 'next/cache';
import { sql, sqlOne } from '@/lib/db/client';
import { grantEditAccess, hasEditAccess, locationFeatureEnabled, verifySecret } from '@/lib/edit-access';
import { geocode } from '@/lib/geocode';

export interface SaveHomeState {
  ok: boolean;
  message: string;
  /** Cozumlenen adres; kullanici yanlissa duzeltebilsin diye geri gosteriliyor. */
  resolved?: string;
}

/**
 * Ev konumunu kaydeder.
 *
 * Erisim: `CONCERTIO_EDIT_SECRET` (bkz. src/lib/edit-access.ts). Auth olmadigi
 * icin kullanici adi tek basina yetki degildir — secret ya formdan gelir ya da
 * daha once dogrulanmis httpOnly cookie'den.
 *
 * Konum SAKLANMADAN ONCE geocode edilir; serbest metni oldugu gibi tutmak
 * yakinlik filtresini calistirmaz.
 */
export async function saveHome(_prev: SaveHomeState, form: FormData): Promise<SaveHomeState> {
  if (!locationFeatureEnabled()) {
    return { ok: false, message: 'Konum özelliği kapalı: CONCERTIO_EDIT_SECRET tanımlı değil.' };
  }

  const lastfmUser = String(form.get('u') ?? '').trim();
  const address = String(form.get('address') ?? '').trim();
  const secret = String(form.get('secret') ?? '');
  const unlockOnly = form.get('intent') === 'unlock';

  let allowed = await hasEditAccess();
  if (!allowed && verifySecret(secret)) {
    await grantEditAccess();
    allowed = true;
  }
  if (!allowed) {
    return { ok: false, message: 'Erişim anahtarı hatalı.' };
  }
  // Anahtar dogrulandi ama henuz adres girilmedi: sadece kilidi ac.
  if (unlockOnly) {
    revalidatePath('/me');
    return { ok: true, message: 'Erişim açıldı. Şimdi adresini girebilirsin.' };
  }

  if (!lastfmUser) return { ok: false, message: 'Last.fm kullanıcı adı gerekli.' };
  if (address.length < 3) return { ok: false, message: 'Adres en az 3 karakter olmalı.' };

  const user = await sqlOne<{ id: string }>(
    'SELECT id FROM app_user WHERE lower(lastfm_user) = lower($1)',
    [lastfmUser],
  );
  if (!user) {
    return { ok: false, message: `${lastfmUser} için profil yok; önce pnpm faz0 çalıştır.` };
  }

  const place = await geocode(address);
  if (!place) {
    return { ok: false, message: 'Adres çözümlenemedi. Şehir ve ülke ekleyerek dene.' };
  }

  await sql(
    `UPDATE app_user
        SET home_label = $2, home_lat = $3, home_lng = $4,
            home_city = $5, home_state = $6, home_country = $7, home_set_at = now()
      WHERE id = $1`,
    [user.id, place.label, place.lat, place.lng, place.city ?? null, place.state ?? null, place.country ?? null],
  );

  revalidatePath('/me');
  return { ok: true, message: 'Ev konumu kaydedildi.', resolved: place.label };
}

/** Ev konumunu siler; filtre tekrar kapanir. */
export async function clearHome(_prev: SaveHomeState, form: FormData): Promise<SaveHomeState> {
  if (!(await hasEditAccess())) {
    return { ok: false, message: 'Erişim anahtarı gerekli.' };
  }
  const lastfmUser = String(form.get('u') ?? '').trim();
  await sql(
    `UPDATE app_user
        SET home_label = NULL, home_lat = NULL, home_lng = NULL,
            home_city = NULL, home_state = NULL, home_country = NULL, home_set_at = NULL
      WHERE lower(lastfm_user) = lower($1)`,
    [lastfmUser],
  );
  revalidatePath('/me');
  return { ok: true, message: 'Ev konumu silindi.' };
}
