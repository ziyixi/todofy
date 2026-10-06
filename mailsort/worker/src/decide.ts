/**
 * The decision (../../docs/design.md §4): pure functions over what the pipeline gathered, so every branch is a unit test.
 *
 * 1. Rules: the first usable active rule of an enabled label decides, in a fixed order (orderRules): rules with
 *    subject conditions (a carve-out) before plain ones, then the most specific kind (address, list, delivered-to,
 *    domain; a longer domain first), then more conditions, then the oldest. A rule is usable when its subject
 *    conditions hold and the mail's authentication does (ruleAuthOk): a sender rule, a trust label and a rule with
 *    `require_dmarc` need DMARC aligned with the From domain, a list rule a DKIM signature of the list's domain. A
 *    forged From therefore never fires a rule: the mail goes on to the model, or stays in the inbox.
 * 2. Neighbours: when the sender passed DMARC aligned and all NEIGHBOURS nearest examples have the same enabled,
 *    non-trust label with similarity of at least NEIGHBOUR_SHORTCUT_SIMILARITY, that label is decided without the model.
 * 3. Clef: label L when the top option is not "none", p(L) reaches L's threshold, p(suspicious) stays below
 *    SUSPICIOUS_MAX, L is enabled and does not imply trust. Anything else is unsure, with the reason.
 */
import type { ClefAnswer } from './ai.ts';
import { listSigned } from './dmarc.ts';
import { NEIGHBOUR_SHORTCUT_SIMILARITY, NEIGHBOURS, NONE, SUBJECT_MATCH_CHARS, SUSPICIOUS_MAX } from './limits.ts';
import type { RuleRow } from './store.ts';

export interface LabelFacts {
  readonly id: string;
  readonly enabled: boolean;
  readonly trust: boolean;
  /** The label's own threshold, or 0 for the default. */
  readonly threshold: number;
}

export interface Candidate {
  readonly label: string;
  readonly probability: number;
}

export type UnsureReason = 'below_threshold' | 'none' | 'suspicious' | 'trust_needs_rule' | 'label_disabled' | 'model_unavailable' | 'no_labels' | 'no_model_labels';

export type Decision =
  | { readonly confident: true; readonly label: string; readonly decider: string; readonly ruleId?: string; readonly keepInInbox?: boolean; readonly candidates: readonly Candidate[] }
  | { readonly confident: false; readonly top: string | null; readonly decider: string; readonly reason: UnsureReason; readonly candidates: readonly Candidate[] };

/** Rule kinds from the most to the least specific. */
const KIND_RANK: Readonly<Record<RuleRow['kind'], number>> = { sender_address: 0, list_id: 1, delivered_to: 2, sender_domain: 3 };

/** A subject as rules compare it: the first SUBJECT_MATCH_CHARS characters, NFKC-folded (full-width to ASCII), lower case. */
export function foldSubject(subject: string): string {
  return subject.slice(0, SUBJECT_MATCH_CHARS).normalize('NFKC').toLowerCase();
}

/** A rule's stored list of words (JSON written by the API, already folded); [] for anything else. */
export function termsOf(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [];
  } catch {
    return [];
  }
}

/** Whether a folded subject meets a rule's conditions: one of its includes (if any), none of its excludes. */
export function subjectMatches(rule: Pick<RuleRow, 'subject_includes' | 'subject_excludes'>, folded: string): boolean {
  const includes = termsOf(rule.subject_includes);
  if (includes.length > 0 && !includes.some((term) => folded.includes(term))) return false;
  return !termsOf(rule.subject_excludes).some((term) => folded.includes(term));
}

function conditionCount(rule: Pick<RuleRow, 'subject_includes' | 'subject_excludes'>): number {
  return termsOf(rule.subject_includes).length + termsOf(rule.subject_excludes).length;
}

/**
 * The order rules are tried in, a total order so the outcome never depends on how SQLite returned them: a rule with
 * subject conditions first, then the kind (address, list, delivered-to, domain), a longer domain before a shorter,
 * more conditions before fewer, then the older rule (create_time, then ID).
 */
export function orderRules<T extends Pick<RuleRow, 'id' | 'kind' | 'value' | 'create_time' | 'subject_includes' | 'subject_excludes'>>(rules: readonly T[]): T[] {
  const key = (rule: T) => [conditionCount(rule) > 0 ? 0 : 1, KIND_RANK[rule.kind], rule.kind === 'sender_domain' ? -rule.value.split('.').length : 0, -conditionCount(rule), rule.create_time] as const;
  return [...rules].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      const d = (ka[i] ?? 0) - (kb[i] ?? 0);
      if (d !== 0) return d;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** What the rules know of a mail's authentication: Gmail's DMARC result and the domains whose DKIM signature passed. */
export interface MailAuth {
  readonly dmarcAligned: boolean;
  readonly dkimDomains: readonly string[];
}

/** Whether a rule may fire for a mail of this authentication (design §4.3). */
export function ruleAuthOk(rule: Pick<RuleRow, 'kind' | 'value' | 'require_dmarc'>, trustLabel: boolean, auth: MailAuth): boolean {
  const needsDmarc = rule.kind === 'sender_address' || rule.kind === 'sender_domain' || trustLabel || rule.require_dmarc === 1;
  if (needsDmarc && !auth.dmarcAligned) return false;
  return rule.kind !== 'list_id' || listSigned(rule.value, auth.dkimDomains);
}

/**
 * The rule that decides (the first usable one in orderRules' order), or null. A carve-out whose subject conditions
 * hold but which cannot fire (its label disabled, the mail not authenticated) stops the search: the mail it carves
 * out must never fall through to the sender's plain rule (a login notice into 投资), so the model decides it.
 */
export function ruleDecision(
  matches: readonly RuleRow[],
  labels: ReadonlyMap<string, LabelFacts>,
  mail: MailAuth & { readonly subject: string },
): { label: string; ruleId: string; keepInInbox: boolean } | null {
  const folded = foldSubject(mail.subject);
  for (const rule of orderRules(matches)) {
    if (!subjectMatches(rule, folded)) continue;
    const label = labels.get(rule.label_id);
    const usable = label !== undefined && label.enabled && ruleAuthOk(rule, label.trust, mail);
    if (usable) return { label: rule.label_id, ruleId: rule.id, keepInInbox: rule.keep_in_inbox === 1 };
    if (conditionCount(rule) > 0) return null;
  }
  return null;
}

export interface Neighbourhood {
  readonly label: string;
  readonly similarity: number;
}

/** The neighbour shortcut's label, or null. */
export function neighbourDecision(neighbours: readonly Neighbourhood[], labels: ReadonlyMap<string, LabelFacts>, dmarcAligned: boolean): string | null {
  if (!dmarcAligned || neighbours.length < NEIGHBOURS) return null;
  const nearest = neighbours.slice(0, NEIGHBOURS);
  const first = nearest[0]?.label;
  if (first === undefined || !nearest.every((n) => n.label === first && n.similarity >= NEIGHBOUR_SHORTCUT_SIMILARITY)) return null;
  const label = labels.get(first);
  return label !== undefined && label.enabled && !label.trust ? first : null;
}

/** The three most likely options of an answer, the most likely first ("none" as the empty label). */
export function candidatesOf(probabilities: Readonly<Record<string, number>>): Candidate[] {
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([label, probability]) => ({ label: label === NONE ? '' : label, probability }));
}

/** Stage 3: the decision from Clef's answer. */
export function clefDecision(answer: ClefAnswer, decider: string, labels: ReadonlyMap<string, LabelFacts>, defaultThreshold: number): Decision {
  const candidates = candidatesOf(answer.probabilities);
  const top = answer.top;
  const unsure = (reason: UnsureReason): Decision => ({ confident: false, top: top === NONE ? null : top, decider, reason, candidates });
  if (top === NONE) return unsure('none');
  const label = labels.get(top);
  if (label === undefined || !label.enabled) return unsure('label_disabled');
  const threshold = label.threshold > 0 ? label.threshold : defaultThreshold;
  if ((answer.probabilities[top] ?? 0) < threshold) return unsure('below_threshold');
  if (answer.suspicious >= SUSPICIOUS_MAX) return unsure('suspicious');
  if (label.trust) return unsure('trust_needs_rule');
  return { confident: true, label: top, decider, candidates };
}
