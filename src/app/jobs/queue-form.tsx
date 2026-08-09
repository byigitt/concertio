'use client';

import { useActionState } from 'react';
import { queueRefresh, type QueueState } from '@/app/jobs/actions';

const initialState: QueueState = { ok: false, message: '' };

/** Yenileme talebi formu. `/jobs` ve `/me` ayni formu kullanir. */
export function QueueForm({
  metros,
  defaultUser,
  defaultMetro,
}: {
  metros: Array<{ slug: string; name: string }>;
  defaultUser?: string;
  defaultMetro?: string;
}) {
  const [state, action, pending] = useActionState(queueRefresh, initialState);

  return (
    <>
      <form action={action}>
        <p>
          <label htmlFor="qu">last.fm username</label>
          <br />
          <input
            id="qu"
            name="u"
            required
            size={22}
            autoComplete="username"
            spellCheck={false}
            defaultValue={defaultUser ?? ''}
          />{' '}
          <label htmlFor="qm">area</label>{' '}
          <select id="qm" name="metro" defaultValue={defaultMetro ?? metros[0]?.slug}>
            {metros.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.name}
              </option>
            ))}
          </select>{' '}
          <button type="submit" disabled={pending}>
            {pending ? 'queueing…' : 'queue refresh'}
          </button>
        </p>
      </form>
      {state.message ? (
        <p role="status">
          <strong>{state.ok ? 'ok:' : 'no:'}</strong> {state.message}
          {state.jobId ? (
            <>
              {' '}
              <a href={`/jobs#${state.jobId}`}>see queue</a>
            </>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
