import { ZodError, type ZodType } from 'zod';
import { loadLimits } from '@/lib/source-config';
import type { SourceId } from '@/lib/types';

/**
 * Kaynak cooldownOnStatuses listesindeki bir HTTP kodu dondurdu; kaynagin
 * TAMAMI gecici kapatilmali (docs/05 pipeline kurallari). Retry EDILMEZ.
 */
export class SourceCooldownError extends Error {
  constructor(
    readonly source: SourceId,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(
      `${source} cooldown: HTTP ${status}` +
        (retryAfterMs !== undefined ? `, Retry-After ${retryAfterMs}ms` : ''),
    );
    this.name = 'SourceCooldownError';
  }
}

/** Gunluk kota (source_config.daily_quota) asildi; kaynak gun sonuna kadar kapali. */
export class SourceQuotaError extends Error {
  constructor(readonly source: SourceId) {
    super(`${source} gunluk kotasi asildi`);
    this.name = 'SourceQuotaError';
  }
}

/**
 * Cooldown listesinde OLMAYAN 4xx/5xx cevaplar. Cagiran taraf ornegin
 * MusicBrainz url-lookup 404'unu normal akis olarak ayirt edebilir:
 * `instanceof HttpStatusError && e.status === 404`.
 */
/**
 * URL'deki gizli parametreleri maskeler.
 *
 * Neden zorunlu: Ticketmaster `?apikey=`, Last.fm `?api_key=` query param'i
 * kullaniyor. Bu URL hata mesajina girer, mesaj `ingest_job.last_error`'a
 * yazilir ve `/jobs` sayfasi PUBLIC. Redaksiyon olmadan API anahtari
 * herkese gorunur olurdu. Kaynakta maskeliyoruz ki hicbir cagiran unutamasin.
 */
const SECRET_PARAMS = ['apikey', 'api_key', 'api_sig', 'sk', 'token', 'client_secret'];

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of SECRET_PARAMS) {
      if (url.searchParams.has(key)) url.searchParams.set(key, 'REDACTED');
    }
    return url.toString();
  } catch {
    // URL parse edilemiyorsa host/path bile guvenli degil: hic gosterme.
    return '(unparseable url)';
  }
}

export class HttpStatusError extends Error {
  /** Maskelenmis URL. Ham URL BILINCLI olarak saklanmiyor. */
  readonly url: string;

  constructor(
    readonly source: SourceId,
    readonly status: number,
    url: string,
    readonly bodySnippet: string,
  ) {
    const safe = redactUrl(url);
    super(`${source} HTTP ${status} (${safe}): ${bodySnippet}`);
    this.url = safe;
    this.name = 'HttpStatusError';
  }
}

/**
 * Kaynak basina siralastirma: ayni kaynaga esZamanli cagrilar bu zincire
 * eklenir, boylece requestsPerSecond asilmaz. Anahtarlar runtime'da eklendigi
 * icin Map.
 */
const chains = new Map<SourceId, Promise<unknown>>();
const lastRequestAt = new Map<SourceId, number>();

/** Retry-After header'i saniye sayisi veya HTTP-date olabilir (RFC 9110 §10.2.3). */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

export async function fetchJson<T>(
  url: string,
  schema: ZodType<T>,
  opts: { source: SourceId; headers?: Record<string, string>; timeoutMs?: number },
): Promise<T> {
  const limits = await loadLimits(opts.source);
  if (!limits.enabled) {
    throw new Error(`${opts.source} devre disi (source_config.enabled=false)`);
  }
  const gapMs = Math.max(1000 / limits.requestsPerSecond, limits.throttleMs ?? 0);

  const prev = chains.get(opts.source) ?? Promise.resolve();
  const run = prev
    // Onceki istegin hatasi bu istegi ilgilendirmez; zincir kopmasin.
    .catch(() => undefined)
    .then(async () => {
      const last = lastRequestAt.get(opts.source);
      if (last !== undefined) {
        const waitMs = last + gapMs - Date.now();
        if (waitMs > 0) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, waitMs);
          await promise;
        }
      }
      lastRequestAt.set(opts.source, Date.now());

      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': process.env.MUSICBRAINZ_USER_AGENT ?? 'concertio/0.1',
          ...opts.headers,
        },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });

      if (limits.cooldownOnStatuses?.includes(response.status)) {
        throw new SourceCooldownError(
          opts.source,
          response.status,
          parseRetryAfter(response.headers.get('retry-after')),
        );
      }
      if (!response.ok) {
        const body = (await response.text()).slice(0, 300);
        throw new HttpStatusError(opts.source, response.status, url, body);
      }

      const payload: unknown = await response.json();
      try {
        return schema.parse(payload);
      } catch (error) {
        if (error instanceof ZodError) {
          const first = error.issues[0];
          throw new Error(
            `${opts.source} schema error (${redactUrl(url)}): ` +
              (first ? `${first.path.join('.')} — ${first.message}` : 'unknown issue'),
          );
        }
        throw error;
      }
    });
  chains.set(opts.source, run.catch(() => undefined));
  return run;
}

/**
 * Ag hatalari icin exponential backoff. SourceCooldownError ve SourceQuotaError
 * retry EDILMEZ: kaynak zaten kapandi, tekrar denemek limiti daha da zorlar.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number },
): Promise<T> {
  const attempts = opts?.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof SourceCooldownError || error instanceof SourceQuotaError) {
        throw error;
      }
      // 4xx deterministiktir (404 vb.); tekrar denemek sonucu degistirmez.
      if (error instanceof HttpStatusError && error.status < 500) {
        throw error;
      }
      lastError = error;
      if (attempt < attempts - 1) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 500 * 2 ** attempt);
        await promise;
      }
    }
  }
  throw lastError;
}
