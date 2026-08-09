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
      <h2>home location</h2>

      {hasAccess ? (
        <>
          <p>
            saved: {homeLabel ? <strong>{homeLabel}</strong> : 'none'}
          </p>

          <form action={saveAction}>
            <input type="hidden" name="u" value={lastfmUser} />
            <input type="hidden" name="metro" value={metroSlug} />
            <fieldset>
              <legend>update address</legend>
              <p>
                <label htmlFor="address">address, neighbourhood or city</label>
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
                  {savePending ? 'saving…' : 'save'}
                </button>
              </p>
              <p id="address-hint">
                like <code>mission district, san francisco</code>. city + country help. no street
                number.
              </p>
            </fieldset>
          </form>

          {homeLabel ? (
            <form action={clearAction}>
              <input type="hidden" name="u" value={lastfmUser} />
              <p>
                <button type="submit" disabled={clearPending}>
                  {clearPending ? 'deleting…' : 'delete location'}
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
            <legend>access</legend>
            <p>
              <label htmlFor="secret">access key</label>
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
                {savePending ? 'checking…' : 'unlock'}
              </button>
            </p>
            <p id="secret-hint">
              address is sensitive, no login yet. key sits in <code>CONCERTIO_EDIT_SECRET</code>.
            </p>
          </fieldset>
        </form>
      )}

      {state.message ? (
        <p role="status">
          <strong>{state.ok ? 'ok:' : 'error:'}</strong> {state.message}
          {state.resolved ? (
            <>
              {' '}
              got: <strong>{state.resolved}</strong>. wrong? write more detail, save again.
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
