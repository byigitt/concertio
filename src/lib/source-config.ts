import { sqlOne } from '@/lib/db/client';
import type { SourceId, SourceLimits } from '@/lib/types';

/**
 * Rate limitler kod sabiti degil, source_config tablosundan okunur (docs/05 §5.1, K-5).
 * cooldownOnStatuses tabloda kolon olarak yok; simdilik tum kaynaklar icin ayni varsayilan.
 */
const COOLDOWN_STATUSES: readonly number[] = [429, 406, 503];

/** Her HTTP isteginde DB'ye gitmemek icin process ici cache. */
const TTL_MS = 60_000;

interface SourceConfigRow {
  requests_per_second: number;
  daily_quota: number | null;
  throttle_ms: number;
  enabled: boolean;
}

export type LoadedLimits = SourceLimits & { enabled: boolean };

const cache = new Map<SourceId, { at: number; value: LoadedLimits }>();

export async function loadLimits(source: SourceId): Promise<LoadedLimits> {
  const hit = cache.get(source);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.value;
  }
  const row = await sqlOne<SourceConfigRow>(
    'SELECT requests_per_second, daily_quota, throttle_ms, enabled FROM source_config WHERE source = $1',
    [source],
  );
  if (!row) {
    throw new Error(`source_config tablosunda satir yok: ${source}`);
  }
  const value: LoadedLimits = {
    // pg "real" kolonu number dondurur ama surucu konfigurasyonuna gore string gelebilir.
    requestsPerSecond: Number(row.requests_per_second),
    throttleMs: row.throttle_ms,
    cooldownOnStatuses: [...COOLDOWN_STATUSES],
    enabled: row.enabled,
    ...(row.daily_quota !== null ? { dailyQuota: row.daily_quota } : {}),
  };
  cache.set(source, { at: Date.now(), value });
  return value;
}
