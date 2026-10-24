/** Two reordered views must agree at the calibrated confidence threshold before a lower priority is accepted. */
import type { ClefAnswer } from './ai.ts';
import {
  AUTO_THRESHOLD,
  NONE,
  NONE_CONFIDENT,
  SECOND_VIEW_LABELS,
  SECOND_VIEW_MIN,
  SENDER_HISTORY_TOP,
} from './limits.ts';

export interface LabelFacts {
  readonly id: string;
  readonly enabled: boolean;
  readonly trust?: boolean;
}

/** One view of the model: its probabilities by label ID (and `none`), its top option. */
export type View = Pick<ClefAnswer, 'probabilities' | 'top'>;

export interface Candidate {
  readonly label: string;
  readonly probability: number;
}

export type UnsureReason = 'low_confidence' | 'views_disagree' | 'model_unavailable' | 'no_labels';

/**
 * The decision. `confidence` is the top option's combined probability (combined): the mean of both views' when view 2
 * ran, else view 1's. `top` is the most likely label (null for `none`). `candidates` are view 1's three most likely
 * options.
 */
export type Decision =
  | { readonly kind: 'label'; readonly label: string; readonly confidence: number; readonly candidates: readonly Candidate[] }
  | { readonly kind: 'none'; readonly confidence: number; readonly candidates: readonly Candidate[] }
  | { readonly kind: 'unsure'; readonly reason: UnsureReason; readonly top: string | null; readonly confidence: number; readonly candidates: readonly Candidate[] };

/** The three most likely options of an answer, the most likely first ("none" as the empty label). */
export function candidatesOf(probabilities: Readonly<Record<string, number>>): Candidate[] {
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([label, probability]) => ({ label: label === NONE ? '' : label, probability }));
}

/**
 * View 2's labels, or null when it does not run: view 1's SECOND_VIEW_LABELS most likely labels (never `none`), the
 * most likely first, when view 1's top option is a label with p >= SECOND_VIEW_MIN. The caller offers them reversed.
 */
export function secondViewLabels(view1: View): string[] | null {
  if (view1.top === NONE || (view1.probabilities[view1.top] ?? 0) < SECOND_VIEW_MIN) return null;
  return Object.entries(view1.probabilities)
    .filter(([id]) => id !== NONE)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, SECOND_VIEW_LABELS)
    .map(([id]) => id);
}

/**
 * The combined probability of `label`: view 1's alone when view 2 did not run, else the mean of view 1's and view 2's
 * on view 1's scale. View 2 chose only among view 1's most likely labels plus none, so its probabilities are relative
 * to those options: a model consistent with itself answers p2(L) = p1(L) / p1(options), which alone would lift the
 * mean above view 1's own p(L). Multiplied by the share view 1 gave those options, view 2 confirms or doubts view 1's
 * probability and is never inflated by its narrower question.
 */
export function combined(view1: View, view2: View | null, label: string): number {
  const p1 = view1.probabilities[label] ?? 0;
  if (view2 === null) return p1;
  const share = Math.min(1, Object.keys(view2.probabilities).reduce((sum, id) => sum + (view1.probabilities[id] ?? 0), 0));
  return (p1 + (view2.probabilities[label] ?? 0) * share) / 2;
}

/** §4's decision from the two views (view 2 null when it did not run). */
export function decideViews(view1: View, view2: View | null, labels: ReadonlyMap<string, LabelFacts>): Decision {
  const candidates = candidatesOf(view1.probabilities);
  const unsure = (reason: UnsureReason, top: string | null, confidence: number): Decision => ({ kind: 'unsure', reason, top, confidence, candidates });
  if (view1.top === NONE) {
    const confidence = view1.probabilities[NONE] ?? 0;
    if (confidence >= NONE_CONFIDENT || view2?.top === NONE) return { kind: 'none', confidence, candidates };
    return unsure('low_confidence', null, confidence);
  }
  const label = view1.top;
  const confidence = combined(view1, view2, label);
  if (view2 === null) return unsure('low_confidence', label, confidence);
  if (view2.top !== label) return unsure('views_disagree', label, confidence);
  // View 1 offers enabled labels only, so a disabled one means the label changed while the mail was decided.
  const facts = labels.get(label);
  if (confidence < AUTO_THRESHOLD || facts === undefined || !facts.enabled) return unsure('low_confidence', label, confidence);
  return { kind: 'label', label, confidence, candidates };
}

// ---- the sender history ---------------------------------------------------------------------------------------------

/** What one label (an ID, or `none`) got from the sender's earlier mail: the owner's verdicts and automatic labels. */
export interface HistoryEntry {
  readonly label: string;
  readonly owner: number;
  readonly auto: number;
}

/**
 * The sender history as the model reads it: the SENDER_HISTORY_TOP entries, the owner's verdicts first, then the most
 * frequent, each as `key ×n` (`keyOf` names a label as the options do; null leaves a label out, a deleted one).
 */
export function historyText(entries: readonly HistoryEntry[], keyOf: (label: string) => string | null): string {
  return [...entries]
    .sort((a, b) => b.owner - a.owner || b.owner + b.auto - (a.owner + a.auto) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .flatMap((entry) => {
      const key = keyOf(entry.label);
      return key === null ? [] : [`${key} ×${String(entry.owner + entry.auto)}`];
    })
    .slice(0, SENDER_HISTORY_TOP)
    .join(', ');
}

// ---- trusted domains (../../docs/design.md §3.2) --------------------------------------------------------------------

/**
 * Public mailbox providers: anyone can send DMARC-aligned mail from them, so none is ever a trusted domain (not seeded,
 * not learned), nor a subdomain of one (`vip.qq.com`). A small fixed list of the common ones, not a complete one.
 */
export const SHARED_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'gmx.net', 'mail.com',
  'yandex.com', 'yandex.ru', 'zoho.com', 'fastmail.com', 'hey.com', 'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net',
  'sina.com', 'sina.cn', 'sohu.com', 'aliyun.com', '139.com', '189.cn', 'naver.com', 'daum.net', 'hanmail.net',
  'hotmail.co.uk', 'yahoo.co.uk', 'yahoo.co.jp', 'outlook.jp', 'hotmail.fr', 'yahoo.fr', 'web.de', 'mail.ru',
]);

/** Whether `domain` is a public mailbox provider's (SHARED_MAILBOX_DOMAINS) or a subdomain of one. */
export function sharedMailbox(domain: string): boolean {
  const parts = domain.toLowerCase().split('.').filter((part) => part !== '');
  for (let i = 0; i + 2 <= parts.length; i++) if (SHARED_MAILBOX_DOMAINS.has(parts.slice(i).join('.'))) return true;
  return false;
}
