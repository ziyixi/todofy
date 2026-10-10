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
import { LabelSchema, type Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb';
import {
  ListExamplesResponseSchema,
  ListLabelsResponseSchema,
  ListLedgerEntriesResponseSchema,
  ListReviewItemsResponseSchema,
  RebuildExampleEmbeddingsResponseSchema,
  SyncLabelsResponseSchema,
  UndoLedgerEntriesResponseSchema,
  type MailsortUiService,
} from '@ziyixi/proto/mailsort/ui/v2/mailsort_ui_service_pb';
import { ReplayEvaluationSchema } from '@ziyixi/proto/mailsort/ui/v2/replay_pb';
import { LedgerEntrySchema, ReviewItemSchema } from '@ziyixi/proto/mailsort/ui/v2/review_pb';
import { LabelCountSchema, LabelReportSchema, ServiceStatus_AuthState, ServiceStatusSchema, SettingsSchema, type Settings } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import { decodePageToken, encodePageToken, PageTokenError, type PageParameters } from '@ziyixi/proto/page-token';
import { create, type DescMessage, type JsonValue, type MessageShape } from '@ziyixi/proto/protobuf';
import { EmptySchema, timestampFromMs, timestampMs } from '@ziyixi/proto/protobuf/wkt';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { needsAction } from './decide.ts';
import type { ModeName } from './env.ts';
import { deleteExample, deleteExamplesOfLabel, dropEmbeddings } from './examples.ts';
import { setVerdict } from './feedback.ts';
import { FLOW_RANGES, readFlow } from './flow.ts';
import { GoogleError, type GmailClient } from './gmail.ts';
import { newEtag, shortId } from './ids.ts';
import {
  CLEF,
  CLEF_FLASH,
  DAILY_WRITE_LIMIT_MAX,
  DAY,
  DESCRIPTION_MAX,
  FLASH_SWITCH_SHARE,
  ID_PATTERN,
  LABEL_ID_PATTERN,
  LABELS_MAX,
  NEURON_BUDGET_MAX,
  NEURON_BUDGET_MIN,
  NONE,
  PAGE,
  RUN_WRITE_LIMIT_MAX,
  UNDO_BATCH,
  UNDO_RANGE_MAX_MS,
} from './limits.ts';
import { exampleMessage, flowMessage, labelMessage, labelName, ledgerMessage, MODES, modeName, replayMessage, reviewMessage } from './model.ts';
import { labelIdFor, ownerPath, pathOfGmailName, treeConflict } from './paths.ts';
import { REASONS, sortError } from './reasons.ts';
import { replaySummary, startReplay } from './replay.ts';
import { authState, type Budget, writeScope } from './session.ts';
import { effectiveMode, readSettings, writeSettings, type SettingsValue } from './settings.ts';
import { utcDay, type DecisionRow, type LabelRow, type LedgerRow, type ReviewRow, type Store } from './store.ts';
import { ensureGmailLabel, ensureGmailParents, executeWrites, hasSublabels, intend, intendUndo, linkGmailLabel, setNameTaken, undoable, userLabelsByName, type WriteContext } from './writes.ts';

/** What every handler gets from MailsortState. */
export interface ApiContext {
  readonly store: Store;
  /** The request's time (epoch milliseconds). */
  readonly now: number;
  readonly build: string;
  readonly ceiling: ModeName;
  readonly env: Parameters<typeof authState>[1];
  readonly transact: <T>(fn: () => T) => T;
  /** Brings the alarm forward (a new mode, a rebuild, a write left for a retry). */
  readonly wake: () => Promise<void>;
  readonly alarmAt: () => Promise<number | null>;
  /** A Gmail client for this request, or why there is none. */
  readonly gmail: () => Promise<GmailClient | 'not_configured' | 'stopped'>;
  readonly budget: Budget;
  readonly shed: boolean;
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
    const answer = run();
    if (requestId !== '') ctx.store.putRequest(requestId, rpc, resource, JSON.stringify(toWire(schema, answer)), ctx.now);
    return answer;
  });
}

/** A mutation with Gmail requests: the replay check, the work (its own transactions), then the log entry. */
async function onceAsync<Desc extends DescMessage>(ctx: ApiContext, requestId: string, rpc: string, resource: string, schema: Desc, run: () => Promise<MessageShape<Desc>>): Promise<MessageShape<Desc>> {
  const logged = ctx.transact(() => replay(ctx, requestId, rpc, resource, schema));
  if (logged !== undefined) return logged;
  const answer = await run();
  if (requestId !== '') ctx.transact(() => { ctx.store.putRequest(requestId, rpc, resource, JSON.stringify(toWire(schema, answer)), ctx.now); });
  return answer;
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

/** A label's path (paths.ts ownerPath), and the tree rule: no label may be the parent of another (only leaves). */
function checkDisplayName(ctx: ApiContext, name: string, exceptId = ''): string {
  // The legacy `分拣/x` means `x` (the import reads it so too); `分拣` itself, or a path starting with it again, is refused.
  const value = ownerPath(name);
  if (value === null) throw sortError('INVALID_LABEL');
  if (treeConflict(value, ctx.store.labelPaths(exceptId)) !== null) throw sortError('INVALID_LABEL');
  return value;
}

function checkDescription(text: string): string {
  if (Array.from(text).length > DESCRIPTION_MAX) throw sortError('INVALID_LABEL');
  return text.trim();
}

function labelEtag(ctx: ApiContext, row: LabelRow, etag: string): void {
  if (etag !== '' && etag !== row.etag) throw sortError('ETAG_MISMATCH', [{ schema: LabelSchema, message: labelOut(ctx, row) }]);
}

/**
 * Renames a linked label in Gmail to its new path (its Gmail name), with any new parents the path needs (`生活/汽车` ->
 * `出行/汽车` needs `出行`; the old ones stay). The store holds the new path first, since the guard renames an owned
 * label only to the path its store plans for it (gmail.ts); a failure puts the old path back.
 */
async function renameInGmail(ctx: ApiContext, before: LabelRow, gmailId: string, path: string): Promise<void> {
  if (!writeScope(ctx.store) || effectiveMode(readSettings(ctx.store), ctx.ceiling) === 'off') throw sortError('GMAIL_WRITE_NOT_ALLOWED');
  const client = await gmailFor(ctx);
  ctx.transact(() => ctx.store.run(`UPDATE labels SET display_name = ? WHERE id = ?`, path, before.id));
  try {
    const existing = userLabelsByName(await client.labels());
    await ensureGmailParents(client, path, existing, ctx.store, ctx.now);
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
  return { item, decision };
}

/** A ledger row as the API answers it (getLedgerEntry, UndoLedgerEntry). */
function ledgerOut(ctx: ApiContext, row: LedgerRow): ReturnType<typeof ledgerMessage> {
  const decision = ctx.store.decision(row.message_id);
  return ledgerMessage(row, { undoable: undoable(row, ctx.store.ownedGmailIds()), subject: decision?.subject ?? null, sender: decision?.sender ?? null });
}

/** The ledger row of mailsort's standing label on a mail, if any. */
function standing(ctx: ApiContext, decision: DecisionRow): LedgerRow | undefined {
  if (decision.outcome !== 'applied' || decision.label_id === null) return undefined;
  const row = ctx.store.one<LedgerRow>(`SELECT * FROM ledger WHERE message_id = ? AND label_id = ? AND state = 'applied' AND superseded = 0 ORDER BY create_time DESC LIMIT 1`, decision.message_id, decision.label_id);
  return row;
}

/**
 * Records the owner's choice and what it teaches: the verdict (and its example), and for a trust label and a mail that
 * passed DMARC its From domain as one of the label's trusted domains. Answers the ledger rows to run: the Gmail writes
 * the choice implies (live mode only).
 */
function choose(ctx: ApiContext, item: ReviewRow, decision: DecisionRow, chosen: string | null): string[] {
  const { store } = ctx;
  setVerdict(store, decision, chosen, 'review', ctx.now);
  // setVerdict resolves the item through pendingReviewOf; this item is the one asked about.
  store.run(`UPDATE review SET state = ?, resolved_label = ?, resolve_time = ? WHERE id = ?`, item.suggested_label === chosen ? 'confirmed' : 'corrected', chosen, ctx.now, item.id);
  const chosenLabel = chosen === null ? undefined : store.label(chosen);
  if (chosenLabel?.trust === 1 && decision.dmarc === 1 && decision.sender_domain !== null && decision.sender_domain !== '') {
    if (store.addTrustedDomain(chosenLabel.id, decision.sender_domain, ctx.now)) store.touchLabel(chosenLabel.id, ctx.now);
  }
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
      // A label that keeps its mail in the inbox does so for the owner's choice too, and so does a mail that asks the
      // owner to act soon.
      const keep = label.keep_in_inbox === 1 || needsAction(decision.needs_action);
      ids.push(intend(store, decision.message_id, label, !keep, 'owner', ctx.now));
    }
  }
  return ids;
}

// ---- settings ----------------------------------------------------------------------------------------------------------------

function settingsMessage(ctx: ApiContext, value: SettingsValue): Settings {
  return create(SettingsSchema, {
    name: 'settings',
    mode: MODES[value.mode],
    effectiveMode: MODES[effectiveMode(value, ctx.ceiling)],
    runWriteLimit: value.runWriteLimit,
    dailyWriteLimit: value.dailyWriteLimit,
    dailyNeuronBudget: value.dailyNeuronBudget,
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
  type Row = { label: string | null; outcome: string; shown: number; gmail: number; review: number; n: number };
  const rows = ctx.store.all<Row>(
    `SELECT coalesce(label_id, top_label) AS label, outcome, shown,
       sum(verdict_source = 'gmail' AND verdict IN ('confirmed', 'corrected') AND coalesce(verdict_label, '') != coalesce(label_id, top_label, '')) AS gmail,
       sum(verdict_source = 'review' AND coalesce(verdict_label, '') != coalesce(label_id, top_label, '')) AS review,
       count(*) AS n
     FROM decisions WHERE decided_at >= ? AND outcome != 'skipped' GROUP BY label, outcome, shown`,
    start,
  );
  const per = new Map<string, { auto: number; gmail: number; review: number; unsure: number; shown: number }>();
  const total = { decided: 0, auto: 0, none: 0, unsure: 0, shown: 0 };
  for (const row of rows) {
    const auto = row.outcome === 'applied' || row.outcome === 'suggested';
    total.decided += row.n;
    if (auto) total.auto += row.n;
    if (row.outcome === 'none') total.none += row.n;
    if (row.outcome === 'unsure') total.unsure += row.n;
    if (row.outcome === 'unsure' && row.shown === 1) total.shown += row.n;
    if (row.label === null) continue;
    const entry = per.get(row.label) ?? { auto: 0, gmail: 0, review: 0, unsure: 0, shown: 0 };
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
      });
    }),
    decidedCount: total.decided,
    autoCount: total.auto,
    noLabelCount: total.none,
    unsureCount: total.unsure,
    shownCount: total.shown,
  });
}

// ---- the handlers ----------------------------------------------------------------------------------------------------------

export const handlers: ServiceHandlers<ShapeOf<typeof MailsortUiService>, ApiContext> = {
  // labels

  listLabels(request, ctx) {
    const size = pageSize(request.pageSize, PAGE);
    const after = cursorOf(request.pageToken, {}, numberCursor) ?? -1;
    const rows = ctx.store.all<LabelRow>(`SELECT * FROM labels WHERE seq > ? ORDER BY seq LIMIT ?`, after, size + 1);
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
    return Promise.resolve(labelOut(ctx, existingLabel(ctx, idOf(request.name, 'labels'))));
  },

  async createLabel(request, ctx) {
    const label = request.label ?? bad('label is required');
    const displayName = checkDisplayName(ctx, label.displayName);
    // Without an ID, one from the path (`金融/投资` -> `finance-invest`): meaningful in URLs and stable.
    // A deleted label's ID is never given again (Store.takenLabelIds): its history still names it.
    const id = request.labelId !== '' ? request.labelId : (labelIdFor(displayName, ctx.store.takenLabelIds()) ?? shortId('l'));
    if (!LABEL_ID_PATTERN.test(id) || id === NONE) throw sortError('INVALID_LABEL');
    const description = checkDescription(label.description);
    const created = once(ctx, request.requestId, 'CreateLabel', `labels/${id}`, LabelSchema, () => {
      const { store } = ctx;
      if (store.takenLabelIds().has(id) || store.one(`SELECT 1 AS x FROM labels WHERE display_name = ?`, displayName) !== undefined) throw sortError('LABEL_EXISTS');
      if (store.count(`SELECT count(*) AS n FROM labels`) >= LABELS_MAX) throw sortError('LIMIT_REACHED');
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
    const before = existingLabel(ctx, id);
    labelEtag(ctx, before, label.etag);
    const displayName = has('display_name') ? checkDisplayName(ctx, label.displayName, id) : before.display_name;
    const description = has('description') ? checkDescription(label.description) : before.description;
    return onceAsync(ctx, request.requestId, 'UpdateLabel', `labels/${id}`, LabelSchema, async () => {
      if (displayName !== before.display_name) {
        if (ctx.store.one(`SELECT 1 AS x FROM labels WHERE display_name = ? AND id != ?`, displayName, id) !== undefined) throw sortError('LABEL_EXISTS');
        // A linked label is renamed in Gmail first: its name is how the owner sees it there.
        if (before.gmail_state === 'linked' && before.gmail_id !== null) await renameInGmail(ctx, before, before.gmail_id, displayName);
      }
      return ctx.transact(() => {
        const { store } = ctx;
        // A new path may be free in Gmail: the next write that needs the label looks again.
        if (displayName !== before.display_name) store.run(`UPDATE labels SET gmail_name_taken = 0 WHERE id = ?`, id);
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
        // A label turned sensitive keeps no example (examples.ts putExample): the ones it has go now, embeddings and
        // all, so their summaries neither outlive the 14 days of content nor reach the model as neighbours.
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
            // Renamed in Gmail: the label takes the new name when it is a path the store can hold (unique, the tree).
            // Any other name (the legacy `分拣/` one among them) is left as it is; writes go by the Gmail ID.
            const path = pathOfGmailName(name);
            if (path === null || path === row.display_name || store.one(`SELECT 1 AS x FROM labels WHERE display_name = ?`, path) !== undefined || treeConflict(path, store.labelPaths(row.id)) !== null) continue;
            store.run(`UPDATE labels SET display_name = ? WHERE id = ?`, path, row.id);
            store.touchLabel(row.id, ctx.now);
            renamed++;
            continue;
          }
          // Not in Gmail yet, or gone from it: the owner's sync adopts the user label of exactly its path (the only place
          // a label is adopted), unless another label here holds it or labels are nested under it (a mail's label is
          // always a leaf). Otherwise a pending label whose path names a Gmail label stays out of Gmail: its name is taken.
          const match = idByName.get(row.display_name);
          if (match !== undefined && store.labelByGmailId(match) === undefined && !hasSublabels(idByName, row.display_name)) {
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
    const rows = ctx.store.all<ReviewRow>(
      `SELECT * FROM review WHERE state = 'pending' AND id < ? ORDER BY id DESC LIMIT ?`,
      before ?? '￿',
      size + 1,
    );
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return Promise.resolve(create(ListReviewItemsResponseSchema, { reviewItems: page.map(reviewMessage), nextPageToken: rows.length > size && last !== undefined ? encodePageToken(last.id, {}) : '' }));
  },

  getReviewItem(request, ctx) {
    return Promise.resolve(reviewMessage(ctx.store.review(idOf(request.name, 'reviewItems')) ?? notFound()));
  },

  async resolveReviewItem(request, ctx) {
    const id = idOf(request.name, 'reviewItems');
    const chosen = request.label === '' ? null : idOf(request.label, 'labels');
    let ids: string[] = [];
    const answer = once(ctx, request.requestId, 'ResolveReviewItem', `reviewItems/${id}`, ReviewItemSchema, () => {
      const { item, decision } = pendingItem(ctx, request.name);
      if (chosen !== null) existingLabel(ctx, chosen);
      ids = choose(ctx, item, decision, chosen);
      return reviewMessage(ctx.store.review(id) ?? notFound());
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
        return reviewMessage(ctx.store.review(id) ?? notFound());
      }),
    );
  },

  // examples

  listExamples(request, ctx) {
    const size = pageSize(request.pageSize, PAGE);
    const label = request.label === '' ? '' : idOf(request.label, 'labels');
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

  async rebuildExampleEmbeddings(request, ctx) {
    const answer = once(ctx, request.requestId, 'RebuildExampleEmbeddings', 'examples', RebuildExampleEmbeddingsResponseSchema, () =>
      create(RebuildExampleEmbeddingsResponseSchema, { queuedCount: dropEmbeddings(ctx.store) }),
    );
    await ctx.wake();
    return answer;
  },

  // the ledger

  listLedgerEntries(request, ctx) {
    const size = pageSize(request.pageSize, PAGE);
    const label = request.label === '' ? '' : idOf(request.label, 'labels');
    const before = cursorOf(request.pageToken, { label }, stringCursor) ?? '￿';
    type Row = LedgerRow & { subject: string | null; sender: string | null };
    const select = `SELECT l.*, d.subject, d.sender FROM ledger l LEFT JOIN decisions d ON d.message_id = l.message_id`;
    const rows =
      label === ''
        ? ctx.store.all<Row>(`${select} WHERE l.id < ? ORDER BY l.id DESC LIMIT ?`, before, size + 1)
        : ctx.store.all<Row>(`${select} WHERE l.label_id = ? AND l.id < ? ORDER BY l.id DESC LIMIT ?`, label, before, size + 1);
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    const owned = ctx.store.ownedGmailIds();
    return Promise.resolve(
      create(ListLedgerEntriesResponseSchema, {
        ledgerEntries: page.map((row) => ledgerMessage(row, { undoable: undoable(row, owned), subject: row.subject, sender: row.sender })),
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
      // Refused before any intent is written: an undo the guard would refuse could only stall the pipeline.
      if (!undoable(row, ctx.store.ownedGmailIds())) throw sortError('NOT_UNDOABLE');
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
    const label = request.label === '' ? '' : idOf(request.label, 'labels');
    return onceAsync(ctx, request.requestId, 'UndoLedgerEntries', 'ledgerEntries', UndoLedgerEntriesResponseSchema, async () => {
      if (!writeScope(ctx.store)) throw sortError('GMAIL_WRITE_NOT_ALLOWED');
      const client = await gmailFor(ctx);
      // The undoable entries of the range (writes.ts undoable): applied, not changed by the owner, label still owned.
      const range = `FROM ledger WHERE state = 'applied' AND superseded = 0 AND create_time >= ? AND create_time < ? AND (? = '' OR label_id = ?)
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

  async startReplayEvaluation(request, ctx) {
    if (request.name !== 'replayEvaluation') notFound();
    const answer = once(ctx, request.requestId, 'StartReplayEvaluation', 'replayEvaluation', ReplayEvaluationSchema, () => {
      startReplay(ctx.store, ctx.now);
      return replayMessage(replaySummary(ctx.store) ?? notFound());
    });
    await ctx.wake();
    return answer;
  },

  async getServiceStatus(request, ctx) {
    if (request.name !== 'serviceStatus') notFound();
    const { store } = ctx;
    const settings = readSettings(store);
    const usage = store.usage(utcDay(ctx.now));
    const auth = authState(store, ctx.env);
    const lastSync = Number(store.getMeta('last_sync_at') ?? '');
    const alarm = await ctx.alarmAt();
    const pending = store.count(`SELECT count(*) AS n FROM pending WHERE not_before <= ?`, ctx.now);
    const deferred = store.count(`SELECT count(*) AS n FROM pending WHERE not_before > ?`, ctx.now);
    const model = ctx.shed || usage.neurons >= FLASH_SWITCH_SHARE * settings.dailyNeuronBudget ? CLEF_FLASH : CLEF;
    return create(ServiceStatusSchema, {
      name: 'serviceStatus',
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
      unsureTodayCount: usage.unsure,
      gmailCallTodayCount: usage.gmail_calls,
      aiCallTodayCount: usage.ai_calls,
      neuronsToday: Math.round(usage.neurons * 10) / 10,
      dailyNeuronBudget: settings.dailyNeuronBudget,
      decisionModel: model === CLEF_FLASH ? 'clef-flash' : 'clef',
      aiQuotaExhausted: usage.quota_exhausted === 1,
      unembeddedExampleCount: store.count(`SELECT count(*) AS n FROM examples WHERE embedding IS NULL`),
      recentErrorCodes: store.errors(),
      build: ctx.build,
    });
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
        } else if (path === 'run_write_limit') next = { ...next, runWriteLimit: integer(input.runWriteLimit, 1, RUN_WRITE_LIMIT_MAX) };
        else if (path === 'daily_write_limit') next = { ...next, dailyWriteLimit: integer(input.dailyWriteLimit, 1, DAILY_WRITE_LIMIT_MAX) };
        else if (path === 'daily_neuron_budget') next = { ...next, dailyNeuronBudget: integer(input.dailyNeuronBudget, NEURON_BUDGET_MIN, NEURON_BUDGET_MAX) };
        else if (!['name', 'etag', 'effective_mode', 'breaker_tripped', 'breaker_reason'].includes(path)) bad('update_mask names an unknown field');
      }
      return settingsMessage(ctx, writeSettings(ctx.store, next, ctx.now));
    });
    await ctx.wake();
    return answer;
  },
};
