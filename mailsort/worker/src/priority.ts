import type { Store } from './store.ts';

/** Reading cadence, independent of Tasks' task priorities. */
export const PRIORITY_LABELS = [
  { id: 'p1', displayName: 'P1', description: 'Prompt attention: waiting 2-3 days risks a required response, an active deadline, an unresolved obligation, or a material consequence. This is positively urgent, not merely a promotional countdown.', keepInInbox: true },
  { id: 'p2', displayName: 'P2', description: 'Important information or required follow-up that can safely wait 2-3 days. Attention is worthwhile or necessary, but not needed today. Optional long-form reading belongs to P3.', keepInInbox: false },
  { id: 'p3', displayName: 'P3', description: 'Substantive optional reading: articles, tutorials, analysis or newsletters worth a weekend reading session. No required response or near-term obligation. This remains P3 on Fridays and weekends.', keepInInbox: false },
  { id: 'p4', displayName: 'P4', description: 'Routine FYI, successful status, confirmations, receipts or promotions without meaningful follow-up or substantial reading value. Optional offer expiry and expired optional events do not make it urgent.', keepInInbox: false },
] as const;

export const P1_ID = 'p1';
export const PRIORITY_IDS: ReadonlySet<string> = new Set(PRIORITY_LABELS.map(label => label.id));
export const MAIL_TIME_ZONE = 'America/Los_Angeles';

export interface PrioritySetup {
  readonly remaining: string[];
  readonly removedLabelCount: number;
  readonly startedAt: number;
  readonly labelsPrepared?: boolean;
}

/** The one-time owner operation freezes only Gmail IDs already owned by Mailsort. */
export function prioritySetup(store: Store): PrioritySetup | null {
  const saved = store.getMeta('priority_setup');
  return saved === null ? null : JSON.parse(saved) as PrioritySetup;
}

export function priorityDeleteIds(store: Store): Set<string> {
  return new Set(prioritySetup(store)?.remaining ?? []);
}

export function priorityStartedAt(store: Store): number {
  return Number(store.getMeta('priority_started_at') ?? '0');
}

export function priorityGmailIds(store: Store): Set<string> {
  return new Set(store.labels().flatMap(label => PRIORITY_IDS.has(label.id) && label.gmail_id !== null ? [label.gmail_id] : []));
}
