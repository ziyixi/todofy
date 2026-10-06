/**
 * Rows of MailsortState's SQLite (store.ts) as the generated messages of mailsort.ui.v1, for the owner API (api.ts).
 */
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { Label_GmailState, LabelSchema, type Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb';
import {
  CandidateSchema,
  Example_Origin,
  ExampleSchema,
  LedgerEntry_State,
  LedgerEntrySchema,
  ReviewItem_Kind,
  ReviewItem_State,
  ReviewItemSchema,
  type Example,
  type LedgerEntry,
  type ReviewItem,
} from '@ziyixi/proto/mailsort/ui/v1/review_pb';
import { Rule_Kind, Rule_State, RuleSchema, type Rule } from '@ziyixi/proto/mailsort/ui/v1/rule_pb';
import { Mode } from '@ziyixi/proto/mailsort/ui/v1/status_pb';
import type { ModeName } from './env.ts';
import type { ExampleRow, LabelRow, LedgerRow, ReviewRow, RuleRow } from './store.ts';

const ts = (ms: number | null) => (ms === null ? undefined : timestampFromMs(ms));

export const labelName = (id: string) => `labels/${id}`;

/** A label reference, or '' for none. */
export const labelRef = (id: string | null) => (id === null || id === '' ? '' : labelName(id));

const GMAIL_STATES = { pending: Label_GmailState.PENDING, linked: Label_GmailState.LINKED, missing: Label_GmailState.MISSING } as const;

export function labelMessage(row: LabelRow, exampleCount: number): Label {
  return create(LabelSchema, {
    name: labelName(row.id),
    displayName: row.display_name,
    description: row.description,
    enabled: row.enabled === 1,
    live: row.live === 1,
    trustImplying: row.trust === 1,
    threshold: row.threshold,
    gmailLabelId: row.gmail_id ?? '',
    gmailState: GMAIL_STATES[row.gmail_state],
    descriptionVersion: row.desc_version,
    exampleCount,
    createTime: ts(row.create_time),
    updateTime: ts(row.update_time),
    etag: row.etag,
  });
}

export const RULE_KINDS = {
  sender_address: Rule_Kind.SENDER_ADDRESS,
  sender_domain: Rule_Kind.SENDER_DOMAIN,
  list_id: Rule_Kind.LIST_ID,
  delivered_to: Rule_Kind.DELIVERED_TO,
} as const;

const RULE_STATES = { proposed: Rule_State.PROPOSED, active: Rule_State.ACTIVE, disabled: Rule_State.DISABLED } as const;

export function ruleMessage(row: RuleRow, trust: boolean): Rule {
  return create(RuleSchema, {
    name: `rules/${row.id}`,
    kind: RULE_KINDS[row.kind],
    value: row.value,
    label: labelName(row.label_id),
    state: RULE_STATES[row.state],
    dmarcRequired: trust,
    correctionCount: row.correction_count,
    matchCount: row.match_count,
    createTime: ts(row.create_time),
    updateTime: ts(row.update_time),
  });
}

const REVIEW_KINDS = { suggestion: ReviewItem_Kind.SUGGESTION, unsure: ReviewItem_Kind.UNSURE, audit: ReviewItem_Kind.AUDIT } as const;
const REVIEW_STATES = { pending: ReviewItem_State.PENDING, confirmed: ReviewItem_State.CONFIRMED, corrected: ReviewItem_State.CORRECTED, skipped: ReviewItem_State.SKIPPED } as const;

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
    kind: REVIEW_KINDS[row.kind],
    state: REVIEW_STATES[row.state],
    subject: row.subject,
    sender: row.sender,
    suggestedLabel: labelRef(row.suggested_label),
    candidates: candidates(row.candidates).map((c) => create(CandidateSchema, { label: labelRef(c.label), probability: c.probability })),
    decider: row.decider,
    unsureReason: row.unsure_reason,
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

export const MODES: Readonly<Record<ModeName, Mode>> = { off: Mode.OFF, shadow: Mode.SHADOW, live: Mode.LIVE };

export function modeName(mode: Mode): ModeName | null {
  return mode === Mode.OFF ? 'off' : mode === Mode.SHADOW ? 'shadow' : mode === Mode.LIVE ? 'live' : null;
}
