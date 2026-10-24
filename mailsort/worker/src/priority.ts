import type { Store } from './store.ts';

/** Reading cadence, independent of Tasks' task priorities. */
export const PRIORITY_LABELS = [
  { id: 'p1', displayName: 'P1', description: '需要及时查看或处理，两三天后再看可能耽误事情；或信息不足、难以确定可以延后多久。保留在收件箱。', keepInInbox: true },
  { id: 'p2', displayName: 'P2', description: '值得查看或需要处理，但可以安全地等两三天；不需要当天关注。', keepInInbox: false },
  { id: 'p3', displayName: 'P3', description: '有阅读价值，可以等到下个周末集中看；此前不会错过需要处理的事项。', keepInInbox: false },
  { id: 'p4', displayName: 'P4', description: '无需行动、可以略过的普通通知、促销或低价值 FYI。重要通知按时效选择 P1 或 P2。', keepInInbox: false },
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
