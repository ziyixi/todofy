/**
 * Rows of MailsortState's SQLite (store.ts) as the generated messages of mailsort.ui.v2, for the owner API (api.ts).
 */
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { Label_GmailState, LabelSchema, type Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb';
import { ReplayEvaluation_MismatchSchema, ReplayEvaluation_State, ReplayEvaluationSchema, type ReplayEvaluation } from '@ziyixi/proto/mailsort/ui/v2/replay_pb';
import {
  CandidateSchema,
  Example_Origin,
  ExampleSchema,
  LedgerEntry_State,
  LedgerEntrySchema,
  ReviewItem_State,
  ReviewItemSchema,
  type Example,
  type LedgerEntry,
  type ReviewItem,
} from '@ziyixi/proto/mailsort/ui/v2/review_pb';
import { MailFlow_CountSchema, MailFlow_Outcome, MailFlow_Stage, MailFlowSchema, type MailFlow } from '@ziyixi/proto/mailsort/ui/v2/flow_pb';
import { Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import type { ModeName } from './env.ts';
import type { FlowCount, FlowOutcome, FlowStage } from './flow.ts';
import type { ReplaySummary } from './replay.ts';
import type { ExampleRow, LabelRow, LedgerRow, ReviewRow } from './store.ts';

const ts = (ms: number | null) => (ms === null ? undefined : timestampFromMs(ms));

export const labelName = (id: string) => `labels/${id}`;

/** A label reference, or '' for none. */
export const labelRef = (id: string | null) => (id === null || id === '' ? '' : labelName(id));

const GMAIL_STATES = { pending: Label_GmailState.PENDING, linked: Label_GmailState.LINKED, missing: Label_GmailState.MISSING } as const;

/**
 * A label's Gmail state; a linked label that adopted the owner's Gmail label of its path says so, and so does a pending
 * one whose path is the name of a Gmail label not its own.
 */
function gmailState(row: LabelRow): Label_GmailState {
  if (row.gmail_state === 'linked' && row.gmail_adopted === 1) return Label_GmailState.ADOPTED;
  if (row.gmail_state === 'pending' && row.gmail_name_taken === 1) return Label_GmailState.NAME_TAKEN;
  return GMAIL_STATES[row.gmail_state];
}

export function labelMessage(row: LabelRow, exampleCount: number, trustedDomains: readonly string[]): Label {
  return create(LabelSchema, {
    name: labelName(row.id),
    displayName: row.display_name,
    description: row.description,
    enabled: row.enabled === 1,
    trustImplying: row.trust === 1,
    gmailLabelId: row.gmail_id ?? '',
    gmailState: gmailState(row),
    descriptionVersion: row.desc_version,
    exampleCount,
    createTime: ts(row.create_time),
    updateTime: ts(row.update_time),
    etag: row.etag,
    keepInInbox: row.keep_in_inbox === 1,
    sensitive: row.sensitive === 1,
    trustedDomains: [...trustedDomains],
  });
}

/** The stages of decisions before 2026-10-10 (`rule`, `neighbours`) have no value: their rows are left out. */
const FLOW_STAGES: Readonly<Partial<Record<FlowStage, MailFlow_Stage>>> = {
  skipped: MailFlow_Stage.SKIPPED,
  clef: MailFlow_Stage.CLEF,
  'clef-flash': MailFlow_Stage.CLEF_FLASH,
  deferred: MailFlow_Stage.DEFERRED,
  no_model: MailFlow_Stage.NO_MODEL,
};

const FLOW_OUTCOMES: Readonly<Record<FlowOutcome, MailFlow_Outcome>> = {
  archived: MailFlow_Outcome.ARCHIVED,
  kept_in_inbox: MailFlow_Outcome.KEPT_IN_INBOX,
  suggested: MailFlow_Outcome.SUGGESTED,
  no_label: MailFlow_Outcome.NO_LABEL,
  unsure: MailFlow_Outcome.UNSURE,
  unsure_shown: MailFlow_Outcome.UNSURE_SHOWN,
  corrected: MailFlow_Outcome.CORRECTED,
  not_inbox: MailFlow_Outcome.NOT_INBOX,
  thread_sorted: MailFlow_Outcome.THREAD_SORTED,
  before_install: MailFlow_Outcome.BEFORE_INSTALL,
  unreadable: MailFlow_Outcome.UNREADABLE,
  deferred: MailFlow_Outcome.DEFERRED,
};

export function flowMessage(range: string, start: number, end: number, counts: readonly FlowCount[]): MailFlow {
  return create(MailFlowSchema, {
    name: `mailFlows/${range}`,
    startTime: timestampFromMs(start),
    endTime: timestampFromMs(end),
    counts: counts.flatMap((count) => {
      // A row of an older stage (rules, neighbours) is left out rather than answered as unspecified.
      const stage = Object.hasOwn(FLOW_STAGES, count.stage) ? FLOW_STAGES[count.stage] : undefined;
      if (stage === undefined || !Object.hasOwn(FLOW_OUTCOMES, count.outcome)) return [];
      return [create(MailFlow_CountSchema, { stage, outcome: FLOW_OUTCOMES[count.outcome], label: labelRef(count.label), mailCount: count.n })];
    }),
  });
}

/** `confirmed` and `corrected` (the owner chose the most likely label, or another) are both resolved. */
const REVIEW_STATES = { pending: ReviewItem_State.PENDING, confirmed: ReviewItem_State.RESOLVED, corrected: ReviewItem_State.RESOLVED, skipped: ReviewItem_State.SKIPPED } as const;

function candidates(text: string): { label: string; probability: number }[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      const { label, probability } = (item ?? {}) as { label?: unknown; probability?: unknown };
      return typeof label === 'string' && typeof probability === 'number' && Number.isFinite(probability) ? [{ label, probability: Math.min(1, Math.max(0, probability)) }] : [];
    });
  } catch {
    return [];
  }
}

export function reviewMessage(row: ReviewRow): ReviewItem {
  return create(ReviewItemSchema, {
    name: `reviewItems/${row.id}`,
    state: REVIEW_STATES[row.state],
    subject: row.subject,
    sender: row.sender,
    candidates: candidates(row.candidates).map((c) => create(CandidateSchema, { label: labelRef(c.label), probability: c.probability })),
    reason: row.unsure_reason,
    resolvedLabel: labelRef(row.resolved_label),
    receiveTime: ts(row.receive_time),
    createTime: ts(row.create_time),
    resolveTime: ts(row.resolve_time),
  });
}

const ORIGINS = { correction: Example_Origin.CORRECTION, confirmation: Example_Origin.CONFIRMATION, weak_accept: Example_Origin.WEAK_ACCEPT } as const;

/** An example row without its vector, and whether it has one. */
export interface ExampleListRow extends Record<string, SqlStorageValue> {
  id: string;
  label_id: string;
  summary: string;
  origin: ExampleRow['origin'];
  create_time: number;
  embedded: number;
}

export function exampleMessage(row: ExampleListRow): Example {
  return create(ExampleSchema, {
    name: `examples/${row.id}`,
    label: labelName(row.label_id),
    summary: row.summary,
    origin: ORIGINS[row.origin],
    embedded: row.embedded === 1,
    createTime: ts(row.create_time),
  });
}

/** The ledger's internal `undo_intended` shows as APPLIED: the label is still on the mail until the undo runs. */
const LEDGER_STATES = {
  intended: LedgerEntry_State.INTENDED,
  applied: LedgerEntry_State.APPLIED,
  failed: LedgerEntry_State.FAILED,
  undo_intended: LedgerEntry_State.APPLIED,
  undone: LedgerEntry_State.UNDONE,
} as const;

/** A ledger row with what the owner needs to tell the entry apart: whether it can be undone, and the mail's text. */
export interface LedgerView {
  readonly undoable: boolean;
  /** The decision's masked subject and sender, null once its content was cleared. */
  readonly subject: string | null;
  readonly sender: string | null;
}

export function ledgerMessage(row: LedgerRow, view: LedgerView): LedgerEntry {
  return create(LedgerEntrySchema, {
    name: `ledgerEntries/${row.id}`,
    messageId: row.message_id,
    label: labelName(row.label_id),
    archived: row.archived === 1,
    origin: row.origin,
    state: LEDGER_STATES[row.state],
    createTime: ts(row.create_time),
    applyTime: ts(row.apply_time),
    undoTime: ts(row.undo_time),
    undoable: view.undoable,
    subject: view.subject ?? '',
    sender: view.sender ?? '',
  });
}

/** The replay evaluation's summary (counts and label names only). */
export function replayMessage(summary: ReplaySummary): ReplayEvaluation {
  return create(ReplayEvaluationSchema, {
    name: 'replayEvaluation',
    state: summary.state === 'succeeded' ? ReplayEvaluation_State.SUCCEEDED : ReplayEvaluation_State.RUNNING,
    createTime: timestampFromMs(summary.createTime),
    completeTime: ts(summary.completeTime),
    totalCount: summary.total,
    evaluatedCount: summary.evaluated,
    skippedCount: summary.skipped,
    autoCount: summary.auto,
    autoMatchCount: summary.autoMatch,
    noLabelCount: summary.none,
    noLabelMatchCount: summary.noneMatch,
    unsureCount: summary.unsure,
    shownCount: summary.shown,
    mismatches: summary.mismatches.map((m) => create(ReplayEvaluation_MismatchSchema, { decidedLabel: labelRef(m.decided), ownerLabel: labelRef(m.owner), mailCount: m.count })),
  });
}

export const MODES: Readonly<Record<ModeName, Mode>> = { off: Mode.OFF, shadow: Mode.SHADOW, live: Mode.LIVE };

export function modeName(mode: Mode): ModeName | null {
  return mode === Mode.OFF ? 'off' : mode === Mode.SHADOW ? 'shadow' : mode === Mode.LIVE ? 'live' : null;
}
