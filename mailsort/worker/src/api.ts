/**
 * The owner API (proto/mailsort/ui/v2): one handler per rpc of MailsortUiService, served by the shared transcoder inside
 * MailsortState (state.ts), after the Worker authenticated the owner and checked Origin and CSRF (http.ts). A handler
 * checks what the IDL cannot (limits.ts), reads or writes the object's SQLite (store.ts) and maps rows to messages
 * (model.ts). A mutation and its AIP-155 request log entry are one transaction; the few that write to Gmail (an owner's
 * review choice in live mode, an undo, a label rename, SyncLabels) record their ledger rows first, make the Gmail
 * requests through writes.ts and gmail.ts, then log the answer.
 *
 * Errors are RpcErrors with a reason of mailsort.ui.v2.ErrorReason or common.errors.v1.CommonReason (reasons.ts). A
 * Gmail failure is DEPENDENCY_UNAVAILABLE (repeat it) or GMAIL_NOT_AUTHORIZED; anything else unexpected is INTERNAL.
 */
import { FieldMaskError, updatePaths } from '@ziyixi/proto/field-mask';
import type { ServiceHandlers, ShapeOf } from '@ziyixi/proto/http-transcoder';
import {
  LabelConsolidation_Group_State, LabelConsolidation_GroupSchema, LabelConsolidation_Phase, LabelConsolidation_State,
  LabelConsolidationSchema, type LabelConsolidation, type LabelConsolidationGroup,
} from '@ziyixi/proto/mailsort/ui/v2/consolidation_pb';
import { LabelSchema, type Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb';
import {
  ListExamplesResponseSchema,
  InitializePrioritiesResponseSchema,
  ListLabelsResponseSchema,
  ListLedgerEntriesResponseSchema,
  ListReviewItemsResponseSchema,
  SyncLabelsResponseSchema,
  UndoLedgerEntriesResponseSchema,
  type MailsortUiService,
} from '@ziyixi/proto/mailsort/ui/v2/mailsort_ui_service_pb';
import { LedgerEntrySchema, ReviewItemSchema } from '@ziyixi/proto/mailsort/ui/v2/review_pb';
import { ClassificationProvider, LabelCountSchema, LabelReportSchema, ServiceStatus_AuthState, ServiceStatusSchema, SettingsSchema, UnreadClassificationSchema, type Settings } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { decodePageToken, encodePageToken, PageTokenError, type PageParameters } from '@ziyixi/proto/page-token';
import { create, type DescMessage, type JsonValue, type MessageShape } from '@ziyixi/proto/protobuf';
import { EmptySchema, timestampFromMs, timestampMs } from '@ziyixi/proto/protobuf/wkt';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { modelRouterBinding, type ModeName } from './env.ts';
import { ClassificationPromptSchema } from '@ziyixi/proto/mailsort/ui/v2/prompt_pb';
import { classificationPromptMessage, readClassificationPrompt, saveClassificationPrompt, validClassificationPrompt } from './classification-prompt.ts';
import { CLASSIFICATION_EFFORT, CODEX_MODEL, CLAUDE_MODEL, CLASSIFIER_MODELS } from './classifier-config.ts';
import { createModelClient, type ModelBinding } from '@ziyixi/model-router-client';
import { deleteExample, deleteExamplesOfLabel } from './examples.ts';
import { setVerdict } from './feedback.ts';
import { FLOW_RANGES, readFlow } from './flow.ts';
import { GoogleError, type GmailClient } from './gmail.ts';
import { newEtag, shortId } from './ids.ts';
import { createLabelMerge, labelMergeSummary, mergeWritesToday, migrationActive, MergeError, resumeLabelMerge, type MergePlanItem, type MergeSummary } from './label-merge.ts';
import { canonicalDecision, canonicalReview, effectiveLedgerRow } from './label-identity.ts';
import {
  DAILY_WRITE_LIMIT_MAX,
  DAY,
  DESCRIPTION_MAX,
  ID_PATTERN,
  LABEL_ID_PATTERN,
  LABELS_MAX,
  NONE,
  PAGE,
  RUN_WRITE_LIMIT_MAX,
  UNDO_BATCH,
  UNDO_RANGE_MAX_MS,
} from './limits.ts';
import { exampleMessage, flowMessage, labelMessage, labelName, ledgerMessage, MODES, modeName, replayMessage, reviewMessage } from './model.ts';
import { labelIdFor, ownerPath, pathOfGmailName, treeConflict } from './paths.ts';
import { REASONS, sortError } from './reasons.ts';
import { replaySummary } from './replay.ts';
import { initializePriorities } from './priority-setup.ts';
import { prioritySetup, priorityStartedAt } from './priority.ts';
import { authState, type Budget, writeScope } from './session.ts';
import { CLASSIFICATION_INTERVAL_MINUTES, effectiveMode, readSettings, writeSettings, type ClassificationProviderName, type SettingsValue } from './settings.ts';
import { CLAUDE_MONTHLY_LIMIT_MICROS, utcDay, type DecisionRow, type LabelRow, type LedgerRow, type ReviewRow, type Store } from './store.ts';
import { startUnread, unreadProgress } from './unread.ts';
import { ensureGmailLabel, executeWrites, hasSublabels, intend, intendUndo, linkGmailLabel, setNameTaken, undoable, userLabelsByName, type WriteContext } from './writes.ts';

/** What every handler gets from MailsortState. */
export interface ApiContext {
  readonly store: Store;
  /** The request's time (epoch milliseconds). */
  readonly now: number;
  readonly build: string;
  readonly ceiling: ModeName;
  readonly env: Parameters<typeof authState>[1] & {
    readonly MODEL_ROUTER?: ModelBinding;
    readonly DEV_FAKE_UPSTREAM?: string;
    readonly DEV_AUTH_BYPASS?: string;
  };
  readonly transact: <T>(fn: () => T) => T;
  /** Brings the alarm forward (a new mode, a rebuild, a write left for a retry). */
  readonly wake: () => Promise<void>;
  readonly alarmAt: () => Promise<number | null>;
  /** A Gmail client for this request, or why there is none. */
  readonly gmail: () => Promise<GmailClient | 'not_configured' | 'stopped'>;
  readonly budget: Budget;
  /** Existing alarm or owner mutation must finish before accepting a consolidation. */
  readonly consolidationBusy: () => boolean;
}

function bad(message = REASONS.BAD_REQUEST.message): never {
  throw new RpcError(REASONS.BAD_REQUEST.code, 'BAD_REQUEST', message);
}

function notFound(): never {
  throw sortError('NOT_FOUND');
}

/** The ID of `<collection>/{id}` (a Worker-made ID), or BAD_REQUEST / INVALID_LABEL. */
function idOf(name: string, collection: string): string {
  const id = name.startsWith(`${collection}/`) ? name.slice(collection.length + 1) : '';
  if (!(collection === 'labels' ? LABEL_ID_PATTERN : ID_PATTERN).test(id)) {
    if (collection === 'labels') throw sortError('INVALID_LABEL');
    bad(`not a ${collection} name`);
  }
  return id;
}

/** page_size (AIP-158): 0 means `max`, a larger value is read as `max`, a negative one is BAD_REQUEST. */
function pageSize(value: number, max: number): number {
  if (value < 0) bad('page_size is negative');
  return value === 0 ? max : Math.min(value, max);
}

function cursorOf<T>(token: string, parameters: PageParameters, read: (cursor: JsonValue) => T | null): T | null {
  if (token === '') return null;
  try {
    return read(decodePageToken(token, parameters)) ?? bad('page_token is not valid');
  } catch (error) {
    if (error instanceof PageTokenError) bad('page_token is not valid');
    throw error;
  }
}

const stringCursor = (cursor: JsonValue) => (typeof cursor === 'string' && cursor.length <= 64 ? cursor : null);
const numberCursor = (cursor: JsonValue) => (typeof cursor === 'number' && Number.isSafeInteger(cursor) ? cursor : null);

// ---- AIP-155 ---------------------------------------------------------------------------------------------------------

function replay<Desc extends DescMessage>(ctx: ApiContext, requestId: string, rpc: string, resource: string, schema: Desc): MessageShape<Desc> | undefined {
  if (requestId === '') return undefined;
  const logged = ctx.store.request(requestId, ctx.now);
  if (logged === undefined) return undefined;
  if (logged.rpc !== rpc || logged.resource !== resource) bad('the request_id was used for another request (another method or resource)');
  return fromWire(schema, JSON.parse(logged.response) as unknown).message;
}

/** A mutation once per request_id: the mutation and its log entry are one transaction. */
function once<Desc extends DescMessage>(ctx: ApiContext, requestId: string, rpc: string, resource: string, schema: Desc, run: () => MessageShape<Desc>): MessageShape<Desc> {
  return ctx.transact(() => {
    const logged = replay(ctx, requestId, rpc, resource, schema);
    if (logged !== undefined) return logged;
    checkConsolidationMutation(ctx, rpc);
    const answer = run();
    if (requestId !== '') ctx.store.putRequest(requestId, rpc, resource, JSON.stringify(toWire(schema, answer)), ctx.now);
    return answer;
  });
}

/** A mutation with Gmail requests: the replay check, the work (its own transactions), then the log entry. */
async function onceAsync<Desc extends DescMessage>(ctx: ApiContext, requestId: string, rpc: string, resource: string, schema: Desc, run: () => Promise<MessageShape<Desc>>): Promise<MessageShape<Desc>> {
  const logged = ctx.transact(() => replay(ctx, requestId, rpc, resource, schema));
  if (logged !== undefined) return logged;
  checkConsolidationMutation(ctx, rpc);
  const answer = await run();
  if (requestId !== '') ctx.transact(() => { ctx.store.putRequest(requestId, rpc, resource, JSON.stringify(toWire(schema, answer)), ctx.now); });
  return answer;
}

/** A frozen consolidation owns label/decision writes until it succeeds; settings still allow an emergency off. */
function checkConsolidationMutation(ctx: ApiContext, rpc: string): void {
  if (rpc === 'InitializePriorities') {
    if (migrationActive(ctx.store)) throw sortError('CONSOLIDATION_ACTIVE');
    return;
  }
  if (rpc !== 'UpdateSettings' && prioritySetup(ctx.store) !== null && priorityStartedAt(ctx.store) === 0) {
    bad('P1–P4 分级正在设置，请先完成设置。');
  }
  if (priorityStartedAt(ctx.store) > 0 && ['CreateLabel', 'UpdateLabel', 'DeleteLabel', 'SyncLabels',
    'StartLabelConsolidation', 'ResumeLabelConsolidation', 'RemoveTrustedDomain'].includes(rpc)) {
    bad('当前使用固定的 P1–P4 分级，请刷新页面。');
  }
  if (rpc === 'UpdateSettings' || rpc === 'StartLabelConsolidation' || rpc === 'ResumeLabelConsolidation') return;
  if (migrationActive(ctx.store)) throw sortError('CONSOLIDATION_ACTIVE');
}

// ---- Gmail from a request --------------------------------------------------------------------------------------------

async function gmailFor(ctx: ApiContext): Promise<GmailClient> {
  const client = await ctx.gmail();
  if (client === 'not_configured' || client === 'stopped') throw sortError('GMAIL_NOT_AUTHORIZED');
  return client;
}

/** Turns a Gmail failure into the API's error (auth, refused write, or a dependency to repeat). */
function gmailError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (error instanceof GoogleError) {
    if (error.kind === 'auth') return sortError('GMAIL_NOT_AUTHORIZED');
    if (error.kind === 'forbidden') return sortError('GMAIL_WRITE_NOT_ALLOWED');
  }
  return sortError('DEPENDENCY_UNAVAILABLE');
}

/** The owner's writes go out only while live is in force with a write grant, read again right before each one. */
function writeContext(ctx: ApiContext, gmail: GmailClient): WriteContext {
  return { store: ctx.store, gmail, budget: ctx.budget, now: () => ctx.now, transact: ctx.transact, gate: () => (ownerWritesAllowed(ctx) ? null : 'mode_changed') };
}

/** Runs the ledger rows `ids` now; a failure to reach Gmail leaves them for the alarm. */
async function flush(ctx: ApiContext, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const client = await ctx.gmail();
  if (client === 'not_configured' || client === 'stopped') {
    await ctx.wake();
    return;
  }
  try {
    const outcome = await executeWrites(writeContext(ctx, client), ids, ids.length);
    if (outcome.stopped) await ctx.wake();
  } catch {
    await ctx.wake();
  }
}

/** The owner's choices may be written to Gmail: live mode in force and a write grant. */
function ownerWritesAllowed(ctx: ApiContext): boolean {
  return effectiveMode(readSettings(ctx.store), ctx.ceiling) === 'live' && writeScope(ctx.store);
}

// ---- labels -------------------------------------------------------------------------------------------------------------

function existingLabel(ctx: ApiContext, id: string): LabelRow {
  if (ctx.store.canonicalLabelId(id) !== id) notFound();
  return ctx.store.label(id) ?? notFound();
}

function labelOut(ctx: ApiContext, row: LabelRow): Label {
  return labelMessage(row, ctx.store.exampleCounts().get(row.id) ?? 0, ctx.store.trustedDomains(row.id));
}

/** Every label (one read of the examples' counts and one of the trusted domains), in the labels' order. */
function labelsOut(store: Store, rows: readonly LabelRow[]): Label[] {
  const counts = store.exampleCounts();
  const domains = store.allTrustedDomains();
  return rows.map((row) => labelMessage(row, counts.get(row.id) ?? 0, domains.get(row.id) ?? []));
}

/** New writes use a single English name; historical paths remain readable. */
function checkDisplayName(ctx: ApiContext, name: string, exceptId = ''): string {
  const value = ownerPath(name);
  if (value === null) throw sortError('INVALID_LABEL');
  if (treeConflict(value, ctx.store.labelPaths(exceptId)) !== null) throw sortError('INVALID_LABEL');
  return value;
}

// ---- label consolidation ----------------------------------------------------------------------------------------------

function consolidationMessage(summary: MergeSummary): LabelConsolidation {
  const states = { running: LabelConsolidation_State.RUNNING, blocked: LabelConsolidation_State.BLOCKED, succeeded: LabelConsolidation_State.SUCCEEDED } as const;
  const phases = { preflight: LabelConsolidation_Phase.PREFLIGHT, rename: LabelConsolidation_Phase.RENAME, move: LabelConsolidation_Phase.MOVE,
    verify: LabelConsolidation_Phase.VERIFY, hide: LabelConsolidation_Phase.HIDE, complete: LabelConsolidation_Phase.COMPLETE } as const;
  const groups = { pending: LabelConsolidation_Group_State.PENDING, running: LabelConsolidation_Group_State.RUNNING, succeeded: LabelConsolidation_Group_State.SUCCEEDED } as const;
  return create(LabelConsolidationSchema, {
    name: 'labelConsolidation', jobId: summary.id, state: states[summary.state], phase: phases[summary.phase], errorCode: summary.errorCode,
    nextAction: summary.state === 'blocked' ? 'resume' : summary.state === 'succeeded' ? 'none' : 'wait',
    createTime: timestampFromMs(summary.createdAt), updateTime: timestampFromMs(summary.updatedAt), etag: summary.etag,
    processedCount: summary.processedCount,
    groups: summary.groups.map((group) => create(LabelConsolidation_GroupSchema, {
      targetLabel: labelName(group.targetLabelId), sourceLabels: group.sourceLabelIds.map(labelName), displayName: group.displayName,
      state: groups[group.state], processedCount: group.processedCount,
    })),
  });
}

function consolidationPlan(ctx: ApiContext, groups: readonly LabelConsolidationGroup[]): MergePlanItem[] {
  if (groups.length === 0 || groups.length > LABELS_MAX) throw sortError('INVALID_LABEL');
  const seen = new Set<string>();
  return groups.map((group) => {
    if (group.sources.length === 0) throw sortError('INVALID_LABEL');
    const sources = group.sources.map((source) => {
      const labelId = idOf(source.label, 'labels');
      if (seen.has(labelId) || seen.size >= LABELS_MAX) throw sortError('INVALID_LABEL');
      seen.add(labelId);
      const label = existingLabel(ctx, labelId);
      if (source.etag === '') bad('every consolidation source needs its current etag');
      labelEtag(ctx, label, source.etag);
      return { labelId, etag: source.etag };
    });
    const targetLabelId = idOf(group.targetLabel, 'labels');
    if (targetLabelId !== sources[0]?.labelId) throw sortError('INVALID_LABEL');
    const displayName = ownerPath(group.displayName);
    if (displayName === null) throw sortError('INVALID_LABEL');
    return { sources, targetLabelId, displayName, ...(group.description === undefined ? {} : { description: checkDescription(group.description) }) };
  });
}

function consolidationError(error: unknown): never {
  if (!(error instanceof MergeError)) throw error;
  switch (error.code) {
    case 'MERGE_BUSY': throw sortError('CONSOLIDATION_ACTIVE');
    case 'MERGE_PENDING_WRITES': throw sortError('CONSOLIDATION_PENDING_WRITES');
    case 'MERGE_ETAG_MISMATCH': throw sortError('ETAG_MISMATCH');
    case 'MERGE_NOT_FOUND': throw sortError('NOT_FOUND');
    case 'MERGE_NOT_BLOCKED': throw sortError('CONSOLIDATION_NOT_BLOCKED');
    case 'MERGE_INVALID_PLAN': throw sortError('INVALID_LABEL');
  }
}

function checkDescription(text: string): string {
  if (Array.from(text).length > DESCRIPTION_MAX) throw sortError('INVALID_LABEL');
  return text.trim();
}

function labelEtag(ctx: ApiContext, row: LabelRow, etag: string): void {
  if (etag !== '' && etag !== row.etag) throw sortError('ETAG_MISMATCH', [{ schema: LabelSchema, message: labelOut(ctx, row) }]);
}

/**
 * Renames a linked label to an English leaf. The store holds the planned name before the guarded Gmail write;
 * a failure restores the old value. Existing grouping labels are never adopted by a rename.
 */
async function renameInGmail(ctx: ApiContext, before: LabelRow, gmailId: string, path: string): Promise<void> {
  if (!writeScope(ctx.store) || effectiveMode(readSettings(ctx.store), ctx.ceiling) === 'off') throw sortError('GMAIL_WRITE_NOT_ALLOWED');
  const client = await gmailFor(ctx);
  ctx.transact(() => ctx.store.run(`UPDATE labels SET display_name = ? WHERE id = ?`, path, before.id));
  try {
    const existing = userLabelsByName(await client.labels());
    if (hasSublabels(existing, path)) throw sortError('INVALID_LABEL');
    await client.renameLabel(gmailId, path);
  } catch (error) {
    ctx.transact(() => ctx.store.run(`UPDATE labels SET display_name = ? WHERE id = ? AND display_name = ?`, before.display_name, before.id, path));
    // 409: Gmail has another label of that name already (one of the owner's).
    if (error instanceof GoogleError && error.code === 'labels_patch_409') throw sortError('LABEL_EXISTS');
    throw gmailError(error);
  }
}

// ---- review ----------------------------------------------------------------------------------------------------------------

function pendingItem(ctx: ApiContext, name: string): { item: ReviewRow; decision: DecisionRow } {
  const item = ctx.store.review(idOf(name, 'reviewItems')) ?? notFound();
  if (item.state !== 'pending') throw sortError('ALREADY_RESOLVED');
  const decision = ctx.store.decision(item.message_id);
  if (decision === undefined) throw sortError('ALREADY_RESOLVED');
  return { item: canonicalReview(ctx.store, item), decision: canonicalDecision(ctx.store, decision) };
}

/** A ledger row as the API answers it (getLedgerEntry, UndoLedgerEntry). */
function ledgerOut(ctx: ApiContext, row: LedgerRow): ReturnType<typeof ledgerMessage> {
  const decision = ctx.store.decision(row.message_id);
  const effective = effectiveLedgerRow(ctx.store, row);
  return ledgerMessage({ ...effective, label_id: ctx.store.canonicalLabelId(effective.label_id) }, { undoable: undoable(effective, ctx.store.ownedGmailIds()), subject: decision?.subject ?? null, sender: decision?.sender ?? null });
}

/** The ledger row of mailsort's standing label on a mail, if any. */
function standing(ctx: ApiContext, decision: DecisionRow): LedgerRow | undefined {
  if (decision.outcome !== 'applied' || decision.label_id === null) return undefined;
  const row = ctx.store.one<LedgerRow>(`SELECT * FROM ledger WHERE message_id = ? AND (label_id = ? OR label_id IN (SELECT source_id FROM label_aliases WHERE target_id = ?))
    AND state = 'applied' AND superseded = 0 ORDER BY create_time DESC LIMIT 1`, decision.message_id, decision.label_id, decision.label_id);
  if (row === undefined) return undefined;
  const effective = effectiveLedgerRow(ctx.store, row);
  return effective.superseded === 1 ? undefined : effective;
}

/** A legacy review item remains readable; priority corrections never teach trusted domains. */
function reviewOut(ctx: ApiContext, row: ReviewRow): ReturnType<typeof reviewMessage> {
  return reviewMessage(canonicalReview(ctx.store, row));
}

/**
 * Records the owner's choice and what it teaches: the verdict (and its example), and for a trust label the mail's
 * teachable From domain (authenticated, not a shared mailbox provider's, not suspicious; teachable) as one of the
 * label's trusted domains, an exact entry. Answers the ledger rows to run: the Gmail writes the choice implies (live
 * mode only).
 */
function choose(ctx: ApiContext, item: ReviewRow, decision: DecisionRow, chosen: string | null): string[] {
  const { store } = ctx;
  setVerdict(store, decision, chosen, 'review', ctx.now);
  // setVerdict resolves the item through pendingReviewOf; this item is the one asked about.
  store.run(`UPDATE review SET state = ?, resolved_label = ?, resolve_time = ? WHERE id = ?`, item.suggested_label === chosen ? 'confirmed' : 'corrected', chosen, ctx.now, item.id);
  if (!ownerWritesAllowed(ctx)) return [];
  const ids: string[] = [];
  const current = standing(ctx, decision);
  if (current !== undefined && current.label_id !== chosen) {
    intendUndo(store, current);
    ids.push(current.id);
  }
  if (chosen !== null && (current === undefined || current.label_id !== chosen)) {
    const label = store.label(chosen);
    // As in the pipeline: a label missing from Gmail, or whose name is taken there, writes nothing.
    if (label !== undefined && label.gmail_state !== 'missing' && label.gmail_name_taken !== 1) {
      // The decision keeps its own label and outcome (the report is about the decision); the ledger row is the owner's.
      // As in the pipeline, the mail is archived unless the label's 归档 is off (keep_in_inbox).
      ids.push(intend(store, decision.message_id, label, label.keep_in_inbox !== 1, 'owner', ctx.now));
    }
  }
  return ids;
}

// ---- settings ----------------------------------------------------------------------------------------------------------------

const CLASSIFICATION_PROVIDERS: Readonly<Record<ClassificationProviderName, ClassificationProvider>> = {
  claude: ClassificationProvider.CLAUDE,
  codex: ClassificationProvider.CODEX,
};

async function configuredModels(env: ApiContext['env']): Promise<ReadonlySet<string>> {
  const binding = modelRouterBinding(env);
  if (!binding) return new Set();
  try {
    const { models } = await createModelClient(binding).listModels({});
    return new Set(models.filter(model => model.configured).map(model => model.id));
  } catch { return new Set(); }
}

function settingsMessage(ctx: ApiContext, value: SettingsValue): Settings {
  return create(SettingsSchema, {
    name: 'settings',
    mode: MODES[value.mode],
    classificationProvider: CLASSIFICATION_PROVIDERS[value.classificationProvider],
    classificationIntervalMinutes: value.classificationIntervalMinutes,
    effectiveMode: MODES[effectiveMode(value, ctx.ceiling)],
    runWriteLimit: value.runWriteLimit,
    dailyWriteLimit: value.dailyWriteLimit,
    breakerTripped: value.breaker !== '',
    breakerReason: value.breaker,
    etag: value.etag,
  });
}

function integer(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw sortError('INVALID_SETTINGS');
  return value;
}

// ---- the label report -------------------------------------------------------------------------------------------------

/**
 * The last 7 UTC days' decisions (today included) per label, in one grouped read of their rows: confident labels, the
 * owner's corrections in Gmail and in the review queue (of a decision's label, or of an uncertain one's most likely),
 * uncertain decisions and the ones shown.
 */
function labelReport(ctx: ApiContext): ReturnType<typeof create<typeof LabelReportSchema>> {
  const start = Math.floor(ctx.now / DAY) * DAY - 6 * DAY;
  type Row = { label: string | null; outcome: string; shown: number; gmail: number; review: number; fallback: number; n: number };
  const rows = ctx.store.all<Row>(
    `SELECT coalesce(selected.target_id, d.label_id, d.top_label) AS label, d.outcome, d.shown,
       sum(d.verdict_source = 'gmail' AND d.verdict IN ('confirmed', 'corrected') AND coalesce(verdict.target_id, d.verdict_label, '') != coalesce(selected.target_id, d.label_id, d.top_label, '')) AS gmail,
       sum(d.verdict_source = 'review' AND coalesce(verdict.target_id, d.verdict_label, '') != coalesce(selected.target_id, d.label_id, d.top_label, '')) AS review,
       sum(d.label_id = 'p1' AND d.unsure_reason IN ('low_confidence', 'views_disagree', 'no_match') AND d.outcome IN ('applied', 'suggested')) AS fallback,
       count(*) AS n
     FROM decisions d LEFT JOIN label_aliases selected ON selected.source_id = coalesce(d.label_id, d.top_label)
       LEFT JOIN label_aliases verdict ON verdict.source_id = d.verdict_label
     WHERE d.decided_at >= ? AND d.outcome != 'skipped' GROUP BY label, d.outcome, d.shown`,
    start,
  );
  const per = new Map<string, { auto: number; gmail: number; review: number; unsure: number; shown: number; fallback: number }>();
  const total = { decided: 0, auto: 0, none: 0, unsure: 0, shown: 0, fallback: 0 };
  for (const row of rows) {
    const auto = row.outcome === 'applied' || row.outcome === 'suggested';
    total.decided += row.n;
    if (auto) total.auto += row.n;
    total.fallback += row.fallback;
    if (row.outcome === 'none') total.none += row.n;
    if (row.outcome === 'unsure') total.unsure += row.n;
    if (row.outcome === 'unsure' && row.shown === 1) total.shown += row.n;
    if (row.label === null) continue;
    const entry = per.get(row.label) ?? { auto: 0, gmail: 0, review: 0, unsure: 0, shown: 0, fallback: 0 };
    entry.fallback += row.fallback;
    if (auto) entry.auto += row.n;
    if (row.outcome === 'unsure') entry.unsure += row.n;
    if (row.outcome === 'unsure' && row.shown === 1) entry.shown += row.n;
    entry.gmail += row.gmail;
    entry.review += row.review;
    per.set(row.label, entry);
  }
  return create(LabelReportSchema, {
    name: 'labelReport',
    labels: ctx.store.labels().map((label) => {
      const entry = per.get(label.id);
      return create(LabelCountSchema, {
        label: labelName(label.id),
        autoCount: entry?.auto ?? 0,
        gmailCorrectionCount: entry?.gmail ?? 0,
        reviewCorrectionCount: entry?.review ?? 0,
        unsureCount: entry?.unsure ?? 0,
        shownCount: entry?.shown ?? 0,
        fallbackCount: entry?.fallback ?? 0,
      });
    }),
    decidedCount: total.decided,
    autoCount: total.auto,
    noLabelCount: total.none,
    unsureCount: total.unsure,
    shownCount: total.shown,
    fallbackCount: total.fallback,
  });
}

// ---- the handlers ----------------------------------------------------------------------------------------------------------

export const handlers: ServiceHandlers<ShapeOf<typeof MailsortUiService>, ApiContext> = {
  // labels

  async initializePriorities(request, ctx) {
    return onceAsync(ctx, request.requestId, 'InitializePriorities', 'labels', InitializePrioritiesResponseSchema, async () => {
      try {
        const result = await initializePriorities(ctx);
        return create(InitializePrioritiesResponseSchema, { ...result, labels: result.completed ? labelsOut(ctx.store, ctx.store.labels()) : [] });
      } catch (error) {
        throw gmailError(error);
      }
    });
  },

  async startUnreadClassification(request, ctx) {
    if (request.name !== 'unreadClassification') notFound();
    if (request.recheckFallback && request.recheckInitial100) bad('请选择一种重判范围。');
    let scope = request.name;
    if (request.recheckInitial100) scope += ':initial100';
    else if (request.recheckFallback) scope += ':fallback';
    const answer = once(ctx, request.requestId, 'StartUnreadClassification', scope, UnreadClassificationSchema, () => {
      if (priorityStartedAt(ctx.store) === 0) bad('请先完成 P1–P4 分级设置。');
      if (!ownerWritesAllowed(ctx)) bad('请先恢复正式模式及 Gmail 写入授权。');
      if (ctx.consolidationBusy()) bad('邮件正在处理，请稍后再开始整理。');
      startUnread(ctx.store, ctx.now, request.recheckFallback, request.recheckInitial100);
      ctx.store.setMeta('next_model_at', String(ctx.now));
      return unreadProgress(ctx.store, ctx.now) ?? notFound();
    });
    await ctx.wake();
    return answer;
  },

  listLabels(request, ctx) {
    const size = pageSize(request.pageSize, PAGE);
    const after = cursorOf(request.pageToken, {}, numberCursor) ?? -1;
    const rows = ctx.store.all<LabelRow>(`SELECT * FROM labels WHERE seq > ? AND id NOT IN (SELECT source_id FROM label_aliases) ORDER BY seq LIMIT ?`, after, size + 1);
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return Promise.resolve(
      create(ListLabelsResponseSchema, {
        labels: labelsOut(ctx.store, page),
        nextPageToken: rows.length > size && last !== undefined ? encodePageToken(last.seq, {}) : '',
      }),
    );
  },

  getLabel(request, ctx) {
    return Promise.resolve(labelOut(ctx, existingLabel(ctx, ctx.store.canonicalLabelId(idOf(request.name, 'labels')))));
  },

  async createLabel(request, ctx) {
    const label = request.label ?? bad('label is required');
    const displayName = checkDisplayName(ctx, label.displayName);
    // Without an ID, derive one from the English name: meaningful in URLs and stable.
    // A deleted label's ID is never given again (Store.takenLabelIds): its history still names it.
    const id = request.labelId !== '' ? request.labelId : (labelIdFor(displayName, ctx.store.takenLabelIds()) ?? shortId('l'));
    if (!LABEL_ID_PATTERN.test(id) || id === NONE) throw sortError('INVALID_LABEL');
    const description = checkDescription(label.description);
    const created = once(ctx, request.requestId, 'CreateLabel', `labels/${id}`, LabelSchema, () => {
      const { store } = ctx;
      if (store.takenLabelIds().has(id) || store.one(`SELECT 1 AS x FROM labels WHERE display_name = ?`, displayName) !== undefined) throw sortError('LABEL_EXISTS');
      if (store.count(`SELECT count(*) AS n FROM labels WHERE id NOT IN (SELECT source_id FROM label_aliases)`) >= LABELS_MAX) throw sortError('LIMIT_REACHED');
      const seq = (store.one<{ seq: number | null }>(`SELECT max(seq) AS seq FROM labels`)?.seq ?? 0) + 1;
      store.run(
        `INSERT INTO labels (id, seq, display_name, description, enabled, trust, gmail_state, desc_version, create_time, update_time, etag, keep_in_inbox, sensitive)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?)`,
        id,
        seq,
        displayName,
        description,
        label.enabled ? 1 : 0,
        label.trustImplying ? 1 : 0,
        ctx.now,
        ctx.now,
        newEtag(ctx.now),
        label.keepInInbox ? 1 : 0,
        label.sensitive ? 1 : 0,
      );
      return labelOut(ctx, existingLabel(ctx, id));
    });
    // In live mode with a write grant the label is created in Gmail at once; otherwise before its first write. Never
    // over a Gmail label of its path: it then stays pending, its name taken (writes.ts ensureGmailLabel).
    const row = ctx.store.label(id);
    if (migrationActive(ctx.store)) return created;
    if (row !== undefined && row.gmail_state === 'pending' && ownerWritesAllowed(ctx)) {
      const client = await ctx.gmail();
      if (client !== 'not_configured' && client !== 'stopped') {
        try {
          await ensureGmailLabel(writeContext(ctx, client), row);
          return labelOut(ctx, existingLabel(ctx, id));
        } catch {
          // Stays pending; the first write that needs it tries again.
        }
      }
    }
    return created;
  },

  async updateLabel(request, ctx) {
    const id = idOf(request.label?.name ?? '', 'labels');
    let paths: '*' | readonly string[];
    try {
      paths = updatePaths(request.updateMask);
    } catch (error) {
      if (error instanceof FieldMaskError) bad('update_mask is not valid');
      throw error;
    }
    const has = (field: string) => paths === '*' || paths.includes(field);
    const label = request.label ?? bad('label is required');
    return onceAsync(ctx, request.requestId, 'UpdateLabel', `labels/${id}`, LabelSchema, async () => {
      const before = existingLabel(ctx, id);
      labelEtag(ctx, before, label.etag);
      const displayName = has('display_name') ? checkDisplayName(ctx, label.displayName, id) : before.display_name;
      const description = has('description') ? checkDescription(label.description) : before.description;
      if (displayName !== before.display_name) {
        if (ctx.store.one(`SELECT 1 AS x FROM labels WHERE display_name = ? AND id != ?`, displayName, id) !== undefined) throw sortError('LABEL_EXISTS');
        // A linked label is renamed in Gmail first: its name is how the owner sees it there.
        if (before.gmail_state === 'linked' && before.gmail_id !== null) await renameInGmail(ctx, before, before.gmail_id, displayName);
      }
      return ctx.transact(() => {
        const { store } = ctx;
        // A new path may be free in Gmail: the next write that needs the label looks again.
        if (displayName !== before.display_name) store.run(`UPDATE labels SET gmail_name_taken = 0, problem = '' WHERE id = ?`, id);
        store.run(
          `UPDATE labels SET display_name = ?, description = ?, enabled = ?, trust = ?, desc_version = desc_version + ?, update_time = ?, etag = ?, keep_in_inbox = ?,
             sensitive = ? WHERE id = ?`,
          displayName,
          description,
          (has('enabled') ? label.enabled : before.enabled === 1) ? 1 : 0,
          (has('trust_implying') ? label.trustImplying : before.trust === 1) ? 1 : 0,
          description !== before.description ? 1 : 0,
          ctx.now,
          newEtag(ctx.now),
          (has('keep_in_inbox') ? label.keepInInbox : before.keep_in_inbox === 1) ? 1 : 0,
          (has('sensitive') ? label.sensitive : before.sensitive === 1) ? 1 : 0,
          id,
        );
        // A label turned sensitive keeps no historical example: the ones it has go now, embeddings and all, so their
        // summaries do not outlive the 14 days of content.
        if (has('sensitive') && label.sensitive && before.sensitive === 0) deleteExamplesOfLabel(store, id);
        return labelOut(ctx, existingLabel(ctx, id));
      });
    });
  },

  deleteLabel(request, ctx) {
    const id = idOf(request.name, 'labels');
    return Promise.resolve(
      once(ctx, request.requestId, 'DeleteLabel', `labels/${id}`, EmptySchema, () => {
        const { store } = ctx;
        const row = existingLabel(ctx, id);
        if (request.etag !== '' && request.etag !== row.etag) throw sortError('ETAG_MISMATCH', [{ schema: LabelSchema, message: labelOut(ctx, row) }]);
        store.run(`DELETE FROM labels WHERE id = ?`, id);
        // Retired: decisions, review items, the ledger and the flow counters keep naming it, so no new label may take
        // the ID and inherit that history (its report, its flow counts, its sender history).
        store.run(`INSERT OR REPLACE INTO retired_labels (id, retire_time) VALUES (?, ?)`, id, ctx.now);
        store.run(`DELETE FROM trusted_domains WHERE label_id = ?`, id);
        deleteExamplesOfLabel(store, id);
        // The Gmail label and its mails stay as they are. Its ledger entries can no longer be undone from here (the
        // label is not owned any more, so the guard would refuse): writes not made fail, undos not made stand.
        store.run(`UPDATE ledger SET state = 'failed', last_code = 'label_deleted' WHERE label_id = ? AND state = 'intended'`, id);
        store.run(`UPDATE ledger SET state = 'applied', last_code = 'label_deleted' WHERE label_id = ? AND state = 'undo_intended'`, id);
        return create(EmptySchema, {});
      }),
    );
  },

  async syncLabels(request, ctx) {
    return onceAsync(ctx, request.requestId, 'SyncLabels', 'labels', SyncLabelsResponseSchema, async () => {
      const client = await gmailFor(ctx);
      let gmailLabels;
      try {
        gmailLabels = await client.labels();
      } catch (error) {
        throw gmailError(error);
      }
      return ctx.transact(() => {
        const { store } = ctx;
        // Only Gmail's user labels count: a system label is never linked. No other Gmail label is ever imported: with
        // no prefix to tell them apart, every label the owner has would be one.
        const idByName = userLabelsByName(gmailLabels);
        const nameById = new Map([...idByName].map(([name, id]) => [id, name]));
        // The record of a parent this app made goes once Gmail no longer has it.
        for (const { gmail_id } of store.all<{ gmail_id: string }>(`SELECT gmail_id FROM gmail_parents`)) if (!nameById.has(gmail_id)) store.run(`DELETE FROM gmail_parents WHERE gmail_id = ?`, gmail_id);
        let linked = 0;
        let renamed = 0;
        let missing = 0;
        for (const row of store.labels()) {
          if (row.gmail_state === 'linked' && row.gmail_id !== null) {
            const name = nameById.get(row.gmail_id);
            if (name === undefined) {
              store.run(`UPDATE labels SET gmail_state = 'missing' WHERE id = ?`, row.id);
              store.touchLabel(row.id, ctx.now);
              missing++;
              continue;
            }
            const path = pathOfGmailName(name);
            const problem = hasSublabels(idByName, name) ? 'has_children' : path === null ? 'invalid_name' : '';
            if (problem !== row.problem) {
              store.run(`UPDATE labels SET problem = ? WHERE id = ?`, problem, row.id);
              store.touchLabel(row.id, ctx.now);
            }
            if (problem !== '' || path === null || path === row.display_name || store.one(`SELECT 1 AS x FROM labels WHERE display_name = ?`, path) !== undefined || treeConflict(path, store.labelPaths(row.id)) !== null) continue;
            store.run(`UPDATE labels SET display_name = ? WHERE id = ?`, path, row.id);
            store.touchLabel(row.id, ctx.now);
            renamed++;
            continue;
          }
          // Not in Gmail yet, or gone from it: the owner's sync adopts the user label of exactly its path (the only place
          // a label is adopted), unless another label here holds it or labels are nested under it (a mail's label is
          // always a leaf). Otherwise a pending label whose path names a Gmail label stays out of Gmail: its name is taken.
          const match = idByName.get(row.display_name);
          const problem = pathOfGmailName(row.display_name) === null ? 'invalid_name' : match !== undefined && hasSublabels(idByName, row.display_name) ? 'has_children' : '';
          if (problem !== row.problem) {
            store.run(`UPDATE labels SET problem = ? WHERE id = ?`, problem, row.id);
            store.touchLabel(row.id, ctx.now);
          }
          if (problem === '' && match !== undefined && store.labelByGmailId(match) === undefined) {
            linkGmailLabel(store, row.id, match, false, ctx.now);
            linked++;
            continue;
          }
          setNameTaken(store, row.id, gmailLabels.some((item) => item.name === row.display_name), ctx.now);
        }
        return create(SyncLabelsResponseSchema, { labels: labelsOut(store, store.labels()), linkedCount: linked, renamedCount: renamed, missingCount: missing });
      });
    });
  },

  getLabelConsolidation(request, ctx) {
    if (request.name !== 'labelConsolidation') notFound();
    return Promise.resolve(consolidationMessage(labelMergeSummary(ctx.store) ?? notFound()));
  },

  async startLabelConsolidation(request, ctx) {
    if (request.name !== 'labelConsolidation') notFound();
    const answer = once(ctx, request.requestId, 'StartLabelConsolidation', request.name, LabelConsolidationSchema, () => {
      if (migrationActive(ctx.store)) throw sortError('CONSOLIDATION_ACTIVE');
      if (ctx.consolidationBusy()) throw sortError('CONSOLIDATION_PENDING_WRITES');
      if (replaySummary(ctx.store)?.state === 'running') throw sortError('REPLAY_ACTIVE');
      const plan = consolidationPlan(ctx, request.groups);
      try {
        return consolidationMessage(createLabelMerge(ctx.store, plan, ctx.now, request.requestId || crypto.randomUUID()));
      } catch (error) {
        return consolidationError(error);
      }
    });
    await ctx.wake();
    return answer;
  },

  async resumeLabelConsolidation(request, ctx) {
    if (request.name !== 'labelConsolidation') notFound();
    const answer = once(ctx, request.requestId, 'ResumeLabelConsolidation', request.name, LabelConsolidationSchema, () => {
      const summary = labelMergeSummary(ctx.store) ?? notFound();
      if (request.etag !== summary.etag) throw sortError('ETAG_MISMATCH', [{ schema: LabelConsolidationSchema, message: consolidationMessage(summary) }]);
      try {
        return consolidationMessage(resumeLabelMerge(ctx.store, summary.id, ctx.now));
      } catch (error) {
        return consolidationError(error);
      }
    });
    await ctx.wake();
    return answer;
  },

  removeTrustedDomain(request, ctx) {
    const id = idOf(request.name, 'labels');
    return Promise.resolve(
      once(ctx, request.requestId, 'RemoveTrustedDomain', `labels/${id}`, LabelSchema, () => {
        const { store } = ctx;
        const row = existingLabel(ctx, id);
        labelEtag(ctx, row, request.etag);
        if (store.run(`DELETE FROM trusted_domains WHERE label_id = ? AND domain = ?`, id, request.domain) === 0) notFound();
        store.touchLabel(id, ctx.now);
        return labelOut(ctx, existingLabel(ctx, id));
      }),
    );
  },

  // review

  listReviewItems(request, ctx) {
    const size = pageSize(request.pageSize, PAGE);
    const before = cursorOf(request.pageToken, {}, stringCursor);
    // With each item, what its decision says of the sender (one read): the domain a trust label's answer would teach.
    type Row = ReviewRow & { dmarc: number | null; sender_domain: string | null; suspicious: number | null };
    const rows = ctx.store.all<Row>(
      `SELECT r.*, d.dmarc, d.sender_domain, d.suspicious FROM review r LEFT JOIN decisions d ON d.message_id = r.message_id
       WHERE r.state = 'pending' AND r.id < ? ORDER BY r.id DESC LIMIT ?`,
      before ?? '￿',
      size + 1,
    );
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return Promise.resolve(
      create(ListReviewItemsResponseSchema, {
        reviewItems: page.map((row) => reviewMessage(canonicalReview(ctx.store, row))),
        nextPageToken: rows.length > size && last !== undefined ? encodePageToken(last.id, {}) : '',
      }),
    );
  },

  getReviewItem(request, ctx) {
    return Promise.resolve(reviewOut(ctx, ctx.store.review(idOf(request.name, 'reviewItems')) ?? notFound()));
  },

  async resolveReviewItem(request, ctx) {
    const id = idOf(request.name, 'reviewItems');
    const chosen = request.label === '' ? null : idOf(request.label, 'labels');
    let ids: string[] = [];
    const answer = once(ctx, request.requestId, 'ResolveReviewItem', `reviewItems/${id}`, ReviewItemSchema, () => {
      const { item, decision } = pendingItem(ctx, request.name);
      if (chosen !== null) existingLabel(ctx, chosen);
      ids = choose(ctx, item, decision, chosen);
      return reviewOut(ctx, ctx.store.review(id) ?? notFound());
    });
    await flush(ctx, ids);
    return answer;
  },

  skipReviewItem(request, ctx) {
    const id = idOf(request.name, 'reviewItems');
    return Promise.resolve(
      once(ctx, request.requestId, 'SkipReviewItem', `reviewItems/${id}`, ReviewItemSchema, () => {
        const { item } = pendingItem(ctx, request.name);
        ctx.store.run(`UPDATE review SET state = 'skipped', resolve_time = ? WHERE id = ?`, ctx.now, item.id);
        return reviewOut(ctx, ctx.store.review(id) ?? notFound());
      }),
    );
  },

  // examples

  listExamples(request, ctx) {
    const size = pageSize(request.pageSize, PAGE);
    const label = request.label === '' ? '' : ctx.store.canonicalLabelId(idOf(request.label, 'labels'));
    const before = cursorOf(request.pageToken, { label }, stringCursor) ?? '￿';
    type Row = { id: string; label_id: string; summary: string; origin: 'correction' | 'confirmation' | 'weak_accept'; message_id: string | null; create_time: number; embedded: number };
    const select = `SELECT id, label_id, summary, origin, message_id, create_time, embedding IS NOT NULL AS embedded FROM examples`;
    const rows = label === ''
      ? ctx.store.all<Row>(`${select} WHERE id < ? ORDER BY id DESC LIMIT ?`, before, size + 1)
      : ctx.store.all<Row>(`${select} WHERE label_id = ? AND id < ? ORDER BY id DESC LIMIT ?`, label, before, size + 1);
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return Promise.resolve(create(ListExamplesResponseSchema, { examples: page.map(exampleMessage), nextPageToken: rows.length > size && last !== undefined ? encodePageToken(last.id, { label }) : '' }));
  },

  getExample(request, ctx) {
    const row = ctx.store.one<{ id: string; label_id: string; summary: string; origin: 'correction' | 'confirmation' | 'weak_accept'; message_id: string | null; create_time: number; embedded: number }>(
      `SELECT id, label_id, summary, origin, message_id, create_time, embedding IS NOT NULL AS embedded FROM examples WHERE id = ?`,
      idOf(request.name, 'examples'),
    );
    return Promise.resolve(exampleMessage(row ?? notFound()));
  },

  deleteExample(request, ctx) {
    const id = idOf(request.name, 'examples');
    return Promise.resolve(
      once(ctx, request.requestId, 'DeleteExample', `examples/${id}`, EmptySchema, () => {
        if (!deleteExample(ctx.store, id)) notFound();
        return create(EmptySchema, {});
      }),
    );
  },

  rebuildExampleEmbeddings() {
    return Promise.reject(sortError('MODEL_FEATURE_RETIRED'));
  },

  // the ledger

  listLedgerEntries(request, ctx) {
    const size = pageSize(request.pageSize, PAGE);
    const label = request.label === '' ? '' : ctx.store.canonicalLabelId(idOf(request.label, 'labels'));
    const before = cursorOf(request.pageToken, { label }, stringCursor) ?? '￿';
    type Row = LedgerRow & { subject: string | null; sender: string | null };
    const select = `SELECT l.*, d.subject, d.sender FROM ledger l LEFT JOIN decisions d ON d.message_id = l.message_id`;
    const rows =
      label === ''
        ? ctx.store.all<Row>(`${select} WHERE l.id < ? ORDER BY l.id DESC LIMIT ?`, before, size + 1)
        : ctx.store.all<Row>(`${select} WHERE (l.label_id = ? OR l.label_id IN (SELECT source_id FROM label_aliases WHERE target_id = ?)) AND l.id < ? ORDER BY l.id DESC LIMIT ?`, label, label, before, size + 1);
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    const owned = ctx.store.ownedGmailIds();
    return Promise.resolve(
      create(ListLedgerEntriesResponseSchema, {
        ledgerEntries: page.map((row) => {
          const effective = effectiveLedgerRow(ctx.store, row);
          return ledgerMessage({ ...effective, label_id: ctx.store.canonicalLabelId(effective.label_id) }, { undoable: undoable(effective, owned), subject: row.subject, sender: row.sender });
        }),
        nextPageToken: rows.length > size && last !== undefined ? encodePageToken(last.id, { label }) : '',
      }),
    );
  },

  getLedgerEntry(request, ctx) {
    return Promise.resolve(ledgerOut(ctx, ctx.store.ledgerRow(idOf(request.name, 'ledgerEntries')) ?? notFound()));
  },

  async undoLedgerEntry(request, ctx) {
    const id = idOf(request.name, 'ledgerEntries');
    return onceAsync(ctx, request.requestId, 'UndoLedgerEntry', `ledgerEntries/${id}`, LedgerEntrySchema, async () => {
      const row = ctx.store.ledgerRow(id) ?? notFound();
      // Merged source history is read-only; normal writes and same-ID renames keep ordinary undo.
      if (!undoable(effectiveLedgerRow(ctx.store, row), ctx.store.ownedGmailIds())) throw sortError('NOT_UNDOABLE');
      if (!writeScope(ctx.store)) throw sortError('GMAIL_WRITE_NOT_ALLOWED');
      const client = await gmailFor(ctx);
      ctx.transact(() => { intendUndo(ctx.store, row); });
      let outcome;
      try {
        outcome = await executeWrites(writeContext(ctx, client), [id], 1);
      } catch (error) {
        await ctx.wake();
        throw gmailError(error);
      }
      const after = ctx.store.ledgerRow(id) ?? notFound();
      if (after.state !== 'undone') {
        await ctx.wake();
        if (outcome.stopped || after.state === 'undo_intended') throw sortError('DEPENDENCY_UNAVAILABLE');
        throw sortError('NOT_UNDOABLE');
      }
      return ledgerOut(ctx, after);
    });
  },

  async undoLedgerEntries(request, ctx) {
    const start = request.startTime === undefined ? NaN : timestampMs(request.startTime);
    const end = request.endTime === undefined ? NaN : timestampMs(request.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > UNDO_RANGE_MAX_MS) bad('the range is not valid (at most 31 days)');
    // 设置's 撤销 with a label chosen undoes that label's entries only; empty is every label's.
    const label = request.label === '' ? '' : ctx.store.canonicalLabelId(idOf(request.label, 'labels'));
    return onceAsync(ctx, request.requestId, 'UndoLedgerEntries', 'ledgerEntries', UndoLedgerEntriesResponseSchema, async () => {
      if (!writeScope(ctx.store)) throw sortError('GMAIL_WRITE_NOT_ALLOWED');
      const client = await gmailFor(ctx);
      const range = `FROM ledger WHERE state = 'applied' AND superseded = 0 AND create_time >= ? AND create_time < ?
        AND (? = '' OR label_id = ?) AND label_id NOT IN (SELECT source_id FROM label_aliases)
        AND gmail_label_id IN (SELECT gmail_id FROM labels WHERE gmail_state = 'linked' AND gmail_id IS NOT NULL)`;
      const rows = ctx.store.all<LedgerRow>(`SELECT * ${range} ORDER BY id DESC LIMIT ?`, start, end, label, label, UNDO_BATCH);
      ctx.transact(() => {
        for (const row of rows) intendUndo(ctx.store, row);
      });
      let failed = 0;
      try {
        const outcome = await executeWrites(writeContext(ctx, client), rows.map((row) => row.id), rows.length);
        failed = outcome.failed;
        if (outcome.stopped) await ctx.wake();
      } catch {
        await ctx.wake();
      }
      const undone = rows.filter((row) => ctx.store.ledgerRow(row.id)?.state === 'undone').length;
      return create(UndoLedgerEntriesResponseSchema, { undoneCount: undone, failedCount: failed, remainingCount: ctx.store.count(`SELECT count(*) AS n ${range}`, start, end, label, label) });
    });
  },

  // the flow

  getMailFlow(request, ctx) {
    const range = request.name.startsWith('mailFlows/') ? request.name.slice('mailFlows/'.length) : '';
    const days = Object.hasOwn(FLOW_RANGES, range) ? FLOW_RANGES[range] : undefined;
    if (days === undefined) notFound();
    const { start, end, counts } = readFlow(ctx.store, days, ctx.now);
    return Promise.resolve(flowMessage(range, start, end, counts));
  },

  // singletons

  getLabelReport(request, ctx) {
    if (request.name !== 'labelReport') notFound();
    return Promise.resolve(labelReport(ctx));
  },

  getReplayEvaluation(request, ctx) {
    if (request.name !== 'replayEvaluation') notFound();
    const summary = replaySummary(ctx.store);
    return Promise.resolve(replayMessage(summary ?? notFound()));
  },

  startReplayEvaluation(request) {
    if (request.name !== 'replayEvaluation') notFound();
    return Promise.reject(sortError('MODEL_FEATURE_RETIRED'));
  },

  async getServiceStatus(request, ctx) {
    if (request.name !== 'serviceStatus') notFound();
    const { store } = ctx;
    const settings = readSettings(store);
    const day = utcDay(ctx.now);
    const usage = store.usage(day);
    const gmailWriteCapFull = usage.applied + mergeWritesToday(store, day) >= settings.dailyWriteLimit;
    const auth = authState(store, ctx.env);
    const lastSync = Number(store.getMeta('last_sync_at') ?? '');
    const alarm = await ctx.alarmAt();
    const pending = store.count(`SELECT count(*) AS n FROM pending WHERE not_before <= ?`, ctx.now);
    const deferred = store.count(`SELECT count(*) AS n FROM pending WHERE not_before > ?`, ctx.now);
    const month = utcDay(ctx.now).slice(0, 7);
    const claude = store.claudeUsage(month);
    const codex = store.codexUsage(month);
    const codexLastRequest = Number(store.getMeta('codex_usage_last_request_at') ?? 0);
    const lastRequest = Number(store.getMeta('claude_last_request_at') ?? 0);
    const nextBatch = Number(store.getMeta('next_model_at') ?? 0);
    const provider = settings.classificationProvider;
    const model = provider === 'codex' ? CODEX_MODEL : CLAUDE_MODEL;
    const connections = await configuredModels(ctx.env);
    const configured = connections.has(CLASSIFIER_MODELS[provider]);
    const lastSuccess = Number(store.getMeta(`${provider}_last_success_at`) ?? 0);
    return create(ServiceStatusSchema, {
      name: 'serviceStatus',
      prioritiesInitialized: priorityStartedAt(store) > 0,
      unreadClassification: unreadProgress(store, ctx.now),
      effectiveMode: MODES[effectiveMode(settings, ctx.ceiling)],
      authState: auth === 'not_configured' ? ServiceStatus_AuthState.NOT_CONFIGURED : auth === 'failed' ? ServiceStatus_AuthState.FAILED : ServiceStatus_AuthState.OK,
      writeScope: writeScope(store),
      ...(Number.isFinite(lastSync) && lastSync > 0 ? { lastSyncTime: timestampFromMs(lastSync) } : {}),
      ...(alarm === null ? {} : { nextAlarmTime: timestampFromMs(alarm) }),
      pendingCount: pending,
      deferredCount: deferred,
      reviewCount: store.count(`SELECT count(*) AS n FROM review WHERE state = 'pending'`),
      decidedTodayCount: usage.decided,
      appliedTodayCount: usage.applied,
      ...(gmailWriteCapFull ? { gmailWriteResumeTime: timestampFromMs(Math.floor(ctx.now / DAY) * DAY + DAY) } : {}),
      unsureTodayCount: usage.unsure,
      gmailCallTodayCount: usage.gmail_calls,
      decisionModel: model,
      classifier: {
        provider: CLASSIFICATION_PROVIDERS[provider], model, effort: CLASSIFICATION_EFFORT, configured,
        classificationIntervalMinutes: settings.classificationIntervalMinutes,
        lastErrorCode: store.getMeta(`${provider}_error`) ?? (configured ? '' : `${provider}_not_configured`),
        ...(Number.isFinite(nextBatch) && nextBatch > 0 ? { nextBatchTime: timestampFromMs(nextBatch) } : {}),
        ...(Number.isFinite(lastSuccess) && lastSuccess > 0 ? { lastSuccessTime: timestampFromMs(lastSuccess) } : {}),
      },
      claudeBudget: {
        model: CLAUDE_MODEL, effort: CLASSIFICATION_EFFORT, month,
        limitUsd: CLAUDE_MONTHLY_LIMIT_MICROS / 1_000_000, spentUsd: claude.cost_micros / 1_000_000,
        inputTokens: claude.input_tokens, outputTokens: claude.output_tokens,
        cacheWriteTokens: claude.cache_write_tokens, cacheReadTokens: claude.cache_read_tokens,
        ...(claude.thinking_tokens === null ? {} : { thinkingTokens: claude.thinking_tokens }),
        ...(lastRequest > 0 ? { lastRequestTime: timestampFromMs(lastRequest) } : {}),
        ...(provider === 'claude' && Number.isFinite(nextBatch) && nextBatch > 0 ? { nextBatchTime: timestampFromMs(nextBatch) } : {}),
        lastErrorCode: store.getMeta('claude_error') ?? (connections.has(CLAUDE_MODEL) ? '' : 'claude_not_configured'),
        providerLimitReached: store.getMeta('claude_limited_month') === month,
      },
      codexUsage: {
        model: CODEX_MODEL, effort: CLASSIFICATION_EFFORT, month,
        inputTokens: codex.input_tokens, outputTokens: codex.output_tokens,
        requestCount: codex.requests, successCount: codex.successes, failureCount: codex.failures,
        usageReportedCount: codex.usage_reported,
        ...(Number.isFinite(codexLastRequest) && codexLastRequest > 0 ? { lastRequestTime: timestampFromMs(codexLastRequest) } : {}),
      },
      recentErrorCodes: store.errors(),
      build: ctx.build,
    });
  },

  getClassificationPrompt(request, ctx) {
    if (request.name !== 'classificationPrompt') notFound();
    return Promise.resolve(classificationPromptMessage(readClassificationPrompt(ctx.store)));
  },

  updateClassificationPrompt(request, ctx) {
    const input = request.classificationPrompt ?? bad('classification_prompt is required');
    if (input.name !== '' && input.name !== 'classificationPrompt') notFound();
    let paths: '*' | readonly string[];
    try { paths = updatePaths(request.updateMask); }
    catch (error) { if (error instanceof FieldMaskError) bad('update_mask is not valid'); throw error; }
    if (paths === '*' || !paths.some(path => path === 'base_text' || path === 'personal_rules')) bad('update_mask must name base_text or personal_rules');
    return Promise.resolve(once(ctx, request.requestId, 'UpdateClassificationPrompt', 'classificationPrompt', ClassificationPromptSchema, () => {
      const current = readClassificationPrompt(ctx.store);
      if (input.etag !== '' && input.etag !== current.etag) throw sortError('ETAG_MISMATCH', [{ schema: ClassificationPromptSchema, message: classificationPromptMessage(current) }]);
      let next = { baseText: current.baseText, personalRules: current.personalRules };
      for (const path of paths) {
        if (path === 'base_text') next = { ...next, baseText: input.baseText };
        else if (path === 'personal_rules') next = { ...next, personalRules: input.personalRules };
        else if (path !== 'etag') bad('update_mask must name base_text or personal_rules');
      }
      if (!validClassificationPrompt(next)) bad('base_text must be nonempty; both prompt fields together must fit 12 KiB UTF-8');
      return classificationPromptMessage(saveClassificationPrompt(ctx.store, next, ctx.now));
    }));
  },

  getSettings(request, ctx) {
    if (request.name !== 'settings') notFound();
    return Promise.resolve(settingsMessage(ctx, readSettings(ctx.store)));
  },

  async updateSettings(request, ctx) {
    const input = request.settings ?? bad('settings is required');
    if (input.name !== '' && input.name !== 'settings') notFound();
    let paths: '*' | readonly string[];
    try {
      paths = updatePaths(request.updateMask);
    } catch (error) {
      if (error instanceof FieldMaskError) bad('update_mask is not valid');
      throw error;
    }
    // An explicit mask only: a client that leaves a field out must never switch the mode by accident.
    if (paths === '*') bad('update_mask must name the fields to change');
    const answer = once(ctx, request.requestId, 'UpdateSettings', 'settings', SettingsSchema, () => {
      const current = readSettings(ctx.store);
      if (input.etag !== '' && input.etag !== current.etag) throw sortError('ETAG_MISMATCH', [{ schema: SettingsSchema, message: settingsMessage(ctx, current) }]);
      let next: Omit<SettingsValue, 'etag'> = { ...current };
      for (const path of paths) {
        if (path === 'mode') {
          const mode = modeName(input.mode);
          if (mode === null) throw sortError('INVALID_SETTINGS');
          // Choosing a mode is the owner's reset of the breaker.
          next = { ...next, mode, breaker: '' };
        } else if (path === 'classification_provider') {
          const provider = input.classificationProvider === ClassificationProvider.CLAUDE ? 'claude'
            : input.classificationProvider === ClassificationProvider.CODEX ? 'codex' : null;
          if (provider === null) throw sortError('INVALID_SETTINGS');
          next = { ...next, classificationProvider: provider };
        } else if (path === 'run_write_limit') next = { ...next, runWriteLimit: integer(input.runWriteLimit, 1, RUN_WRITE_LIMIT_MAX) };
        else if (path === 'classification_interval_minutes') {
          if (!CLASSIFICATION_INTERVAL_MINUTES.includes(input.classificationIntervalMinutes)) throw sortError('INVALID_SETTINGS');
          next = { ...next, classificationIntervalMinutes: input.classificationIntervalMinutes };
        } else if (path === 'daily_write_limit') next = { ...next, dailyWriteLimit: integer(input.dailyWriteLimit, 1, DAILY_WRITE_LIMIT_MAX) };
        // A retired field an older UI may still name is accepted and ignored.
        else if (!['name', 'etag', 'effective_mode', 'breaker_tripped', 'breaker_reason', 'daily_neuron_budget'].includes(path)) bad('update_mask names an unknown field');
      }
      if (next.classificationProvider !== current.classificationProvider) {
        ctx.store.setMeta('next_model_at', String(ctx.now));
        ctx.store.run('UPDATE pending SET not_before = ? WHERE deferred > 0', ctx.now);
      }
      return settingsMessage(ctx, writeSettings(ctx.store, next, ctx.now));
    });
    await ctx.wake();
    return answer;
  },
};
