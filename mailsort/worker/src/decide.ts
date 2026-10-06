/**
 * The decision (../../docs/design.md §4): pure functions over what the pipeline gathered, so every branch is a unit test.
 *
 * 1. Rules: an active rule of an enabled label decides. A label that implies trust needs a rule AND DMARC aligned with
 *    the From domain; without DMARC such a rule is skipped. When rules of the strongest matching kind disagree, no rule
 *    decides (the model does).
 * 2. Neighbours: when the sender passed DMARC aligned and all NEIGHBOURS nearest examples have the same enabled,
 *    non-trust label with similarity of at least NEIGHBOUR_SHORTCUT_SIMILARITY, that label is decided without the model.
 * 3. Clef: label L when the top option is not "none", p(L) reaches L's threshold, p(suspicious) stays below
 *    SUSPICIOUS_MAX, L is enabled and does not imply trust. Anything else is unsure, with the reason.
 */
import type { ClefAnswer } from './ai.ts';
import { NEIGHBOUR_SHORTCUT_SIMILARITY, NEIGHBOURS, NONE, SUSPICIOUS_MAX } from './limits.ts';
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

export type UnsureReason = 'below_threshold' | 'none' | 'suspicious' | 'trust_needs_rule' | 'label_disabled' | 'model_unavailable' | 'no_labels';

export type Decision =
  | { readonly confident: true; readonly label: string; readonly decider: string; readonly ruleId?: string; readonly candidates: readonly Candidate[] }
  | { readonly confident: false; readonly top: string | null; readonly decider: string; readonly reason: UnsureReason; readonly candidates: readonly Candidate[] };

/** Rule kinds from the most to the least specific. */
const KIND_ORDER: readonly RuleRow['kind'][] = ['sender_address', 'list_id', 'delivered_to', 'sender_domain'];

/** The rule that decides, or null. */
export function ruleDecision(matches: readonly RuleRow[], labels: ReadonlyMap<string, LabelFacts>, dmarcAligned: boolean): { label: string; ruleId: string } | null {
  for (const kind of KIND_ORDER) {
    const usable = matches.filter((rule) => {
      if (rule.kind !== kind) return false;
      const label = labels.get(rule.label_id);
      return label !== undefined && label.enabled && (!label.trust || dmarcAligned);
    });
    const decided = new Set(usable.map((rule) => rule.label_id));
    if (decided.size === 1) {
      const rule = usable[0];
      if (rule !== undefined) return { label: rule.label_id, ruleId: rule.id };
    }
    // Two labels of the same kind (or none): look at the next kind only when none matched here.
    if (decided.size > 1) return null;
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
