/**
 * Step 7 of the noise pipeline, the AI judge (../../docs/design.md §5): OFF in v1. Watch.ai.enabled is refused
 * (AI_NOT_AVAILABLE), every change is decided by the rules (classifier RULE), and no model is called. This is the
 * interface a later step implements: it sees a change the rules confirmed, never a suppressed one, and may only drop
 * it (with a reason the drawer shows) or keep it; it never confirms what the rules suppressed.
 */
import type { TriggerKind } from './config.ts';

export interface JudgeInput {
  /** The owner's intent for the page (AiOptions.intent). */
  readonly intent: string;
  readonly triggerKind: TriggerKind;
  /** The kept diff lines (normalized, masked). */
  readonly diff: readonly { readonly kind: 'added' | 'removed'; readonly text: string }[];
}

export type JudgeVerdict = { readonly keep: true } | { readonly keep: false; readonly reason: string };

export interface ChangeJudge {
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}

/** v1: there is no judge. */
export const NO_JUDGE: ChangeJudge | null = null;
