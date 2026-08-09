import type { EventSource, TasteSource } from '@/lib/types';
import { lastfm } from './lastfm';
import { ticketmaster } from './ticketmaster';

/**
 * Kaynak kaydi: pipeline tum kaynaklari buradan kesfeder ve isConfigured()
 * dondurmeyenleri atlar (docs/05 §4, K-5). Henuz yazilmamis kaynaklar
 * (seatgeek, spotify) eklenmez; adapter'i geldiginde buraya eklenir.
 */
export const eventSources: EventSource[] = [ticketmaster];

export const tasteSources: TasteSource[] = [lastfm];

export { lastfm, ticketmaster };
