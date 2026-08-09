'use client';

import { useActionState } from 'react';
import { clearHome, saveHome, type SaveHomeState } from '@/app/me/actions';

const initialState: SaveHomeState = { ok: false, message: '' };

/**
 * Ev konumu paneli.
 *
 * Uc durum:
 *   - Ozellik kapali (`CONCERTIO_EDIT_SECRET` yok): hicbir sey gosterilmez.
 *   - Erisim yok: sadece anahtar alani. Kayitli konum hassas oldugu icin
 *     dogrulanmamis cagirana adres alani bile gosterilmez.
 *   - Erisim var: adres formu + kayitli konum + silme.
 *
 * <fieldset>/<legend> kullaniliyor: alanlar arasindaki iliskiyi ekran okuyucuya
 * yapinin kendisi anlatiyor, ek ARIA gerekmiyor.
 */
export function HomePanel({
  lastfmUser,
  metroSlug,
  featureEnabled,
  hasAccess,
  homeLabel,
}: {
  lastfmUser: string;
  metroSlug: string;
  featureEnabled: boolean;
  hasAccess: boolean;
  homeLabel: string | null;
}) {
  const [saveState, saveAction, savePending] = useActionState(saveHome, initialState);
  const [clearState, clearAction, clearPending] = useActionState(clearHome, initialState);

  if (!featureEnabled) return null;

  const state = saveState.message ? saveState : clearState;

  return (
    <section>
      <h2>Ev konumu</h2>

      {hasAccess ? (
        <>
          <p>
            Kayıtlı: {homeLabel ? <strong>{homeLabel}</strong> : 'yok'}
          </p>

          <form action={saveAction}>
            <input type="hidden" name="u" value={lastfmUser} />
            <input type="hidden" name="metro" value={metroSlug} />
            <fieldset>
              <legend>Adresi güncelle</legend>
              <p>
                <label htmlFor="address">Adres, semt veya şehir</label>
                <br />
                <input
                  id="address"
                  name="address"
                  required
                  minLength={3}
                  size={36}
                  autoComplete="street-address"
                  aria-describedby="address-hint"
                />{' '}
                <button type="submit" disabled={savePending}>
                  {savePending ? 'Kaydediliyor…' : 'Kaydet'}
                </button>
              </p>
              <p id="address-hint">
                Örnek: <code>Mission District, San Francisco</code>. Şehir ve ülke eklemek
                çözümlemeyi belirginleştirir. Sokak numarası vermek zorunda değilsin; semt de yeter.
              </p>
            </fieldset>
          </form>

          {homeLabel ? (
            <form action={clearAction}>
              <input type="hidden" name="u" value={lastfmUser} />
              <p>
                <button type="submit" disabled={clearPending}>
                  {clearPending ? 'Siliniyor…' : 'Kayıtlı konumu sil'}
                </button>
              </p>
            </form>
          ) : null}
        </>
      ) : (
        <form action={saveAction}>
          <input type="hidden" name="u" value={lastfmUser} />
          <input type="hidden" name="intent" value="unlock" />
          <fieldset>
            <legend>Erişim</legend>
            <p>
              <label htmlFor="secret">Erişim anahtarı</label>
              <br />
              <input
                id="secret"
                name="secret"
                type="password"
                required
                size={36}
                autoComplete="off"
                aria-describedby="secret-hint"
              />{' '}
              <button type="submit" disabled={savePending}>
                {savePending ? 'Kontrol ediliyor…' : 'Aç'}
              </button>
            </p>
            <p id="secret-hint">
              Ev adresi hassas veri ve uygulamada henüz oturum yok, o yüzden konum özelliği bir
              anahtarla korunuyor. Anahtar <code>CONCERTIO_EDIT_SECRET</code> ortam değişkeninde.
            </p>
          </fieldset>
        </form>
      )}

      {state.message ? (
        <p role="status">
          <strong>{state.ok ? 'Tamam:' : 'Hata:'}</strong> {state.message}
          {state.resolved ? (
            <>
              {' '}
              Çözümlenen adres: <strong>{state.resolved}</strong>. Yanlışsa daha ayrıntılı yazıp
              tekrar kaydet.
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
