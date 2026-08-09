'use client';

import { useActionState } from 'react';
import { clearHome, saveHome, type SaveHomeState } from '@/app/me/actions';

const initialState: SaveHomeState = { ok: false, message: '' };

/**
 * Ev konumu paneli.
 *
 * Uc durum var:
 *   - Ozellik kapali (`CONCERTIO_EDIT_SECRET` yok): hicbir sey gosterilmez.
 *   - Erisim yok: sadece anahtar alani. Adres alani bile gosterilmez, cunku
 *     kayitli konum hassas ve dogrulanmamis cagirana sizmamali.
 *   - Erisim var: adres formu + kayitli konum + silme.
 */
export function HomePanel({
  lastfmUser,
  featureEnabled,
  hasAccess,
  homeLabel,
}: {
  lastfmUser: string;
  featureEnabled: boolean;
  hasAccess: boolean;
  homeLabel: string | null;
}) {
  const [saveState, saveAction, savePending] = useActionState(saveHome, initialState);
  const [clearState, clearAction, clearPending] = useActionState(clearHome, initialState);

  if (!featureEnabled) return null;

  const state = saveState.message ? saveState : clearState;

  return (
    <section className="max-w-xl space-y-3 border-l-2 border-line pl-5">
      <h2 className="text-xs uppercase tracking-[0.18em] text-faint">Ev konumu</h2>

      {hasAccess && homeLabel ? (
        <p className="text-sm leading-relaxed text-muted">
          <span className="text-paper">{homeLabel}</span>
        </p>
      ) : null}

      <form action={saveAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="u" value={lastfmUser} />

        {hasAccess ? (
          <label className="flex-1 space-y-1">
            <span className="block text-xs text-faint">Adres, semt veya şehir</span>
            <input
              name="address"
              required
              minLength={3}
              placeholder="Mission District, San Francisco"
              className="w-full border-b border-line bg-transparent pb-1 text-sm text-paper outline-none focus-visible:border-accent"
            />
          </label>
        ) : (
          <label className="flex-1 space-y-1">
            <span className="block text-xs text-faint">Erişim anahtarı</span>
            <input
              name="secret"
              type="password"
              required
              autoComplete="off"
              className="w-full border-b border-line bg-transparent pb-1 text-sm text-paper outline-none focus-visible:border-accent"
            />
            <input type="hidden" name="intent" value="unlock" />
          </label>
        )}

        <button
          type="submit"
          disabled={savePending}
          className="pb-1 text-sm text-accent transition-opacity disabled:opacity-50"
        >
          {savePending ? 'Kaydediliyor' : hasAccess ? 'Kaydet' : 'Aç'}
        </button>
      </form>

      {hasAccess && homeLabel ? (
        <form action={clearAction}>
          <input type="hidden" name="u" value={lastfmUser} />
          <button
            type="submit"
            disabled={clearPending}
            className="text-xs text-faint transition-colors hover:text-paper disabled:opacity-50"
          >
            Konumu sil
          </button>
        </form>
      ) : null}

      {state.message ? (
        <p className={`text-xs ${state.ok ? 'text-accent' : 'text-muted'}`} role="status">
          {state.message}
        </p>
      ) : null}

      {hasAccess ? (
        <p className="text-xs leading-relaxed text-faint">
          Mesafeler düz hat üzerinden hesaplanır, gerçek yol veya toplu taşıma rotası değil.
          Adres çözümlemesi{' '}
          <a href="https://nominatim.openstreetmap.org/" target="_blank" rel="noreferrer">
            OpenStreetMap Nominatim
          </a>{' '}
          ile yapılır.
        </p>
      ) : null}
    </section>
  );
}
