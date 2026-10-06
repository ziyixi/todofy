/**
 * The owner API (proto/mailsort/ui/v1): one handler per rpc of MailsortUiService, served by the shared transcoder inside
 * MailsortState (state.ts), after the Worker authenticated the owner and checked Origin and CSRF (http.ts). A handler
 * checks what the IDL cannot (limits.ts), reads or writes the object's SQLite (store.ts) and maps rows to messages
 * (model.ts). A mutation and its AIP-155 request log entry are one transaction; the few that write to Gmail (an owner's
 * review choice in live mode, an undo, a label rename, SyncLabels) record their ledger rows first, make the Gmail
 * requests through writes.ts and gmail.ts, then log the answer.
 *
 * Errors are RpcErrors with a reason of mailsort.ui.v1.ErrorReason or common.errors.v1.CommonReason (reasons.ts). A
 * Gmail failure is DEPENDENCY_UNAVAILABLE (repeat it) or GMAIL_NOT_AUTHORIZED; anything else unexpected is INTERNAL.
 */
import { FieldMaskError, updatePaths } from '@ziyixi/proto/field-mask';
import type { ServiceHandlers, ShapeOf } from '@ziyixi/proto/http-transcoder';
import { LabelSchema, type Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb';
import {
  ExportGmailFiltersResponseSchema,
  ListExamplesResponseSchema,
  ListLabelsResponseSchema,
  ListLedgerEntriesResponseSchema,
  ListReviewItemsResponseSchema,
  ListRulesResponseSchema,
  RebuildExampleEmbeddingsResponseSchema,
  SyncLabelsResponseSchema,
  UndoLedgerEntriesResponseSchema,
  type MailsortUiService,
} from '@ziyixi/proto/mailsort/ui/v1/mailsort_ui_service_pb';
import { LedgerEntrySchema, ReviewItemSchema } from '@ziyixi/proto/mailsort/ui/v1/review_pb';
import { Rule_Kind, RuleSchema } from '@ziyixi/proto/mailsort/ui/v1/rule_pb';
import { AccuracyReportSchema, LabelAccuracySchema, ServiceStatus_AuthState, ServiceStatusSchema, SettingsSchema, type Settings } from '@ziyixi/proto/mailsort/ui/v1/status_pb';
import { decodePageToken, encodePageToken, PageTokenError, type PageParameters } from '@ziyixi/proto/page-token';
import { create, type DescMessage, type JsonValue, type MessageShape } from '@ziyixi/proto/protobuf';
import { EmptySchema, timestampFromMs, timestampMs } from '@ziyixi/proto/protobuf/wkt';
import { RpcError } from '@ziyixi/proto/rpc-status';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { labelStats } from './accuracy.ts';
import type { ModeName } from './env.ts';
import { deleteExample, deleteExamplesOfLabel, dropEmbeddings } from './examples.ts';
import { setVerdict } from './feedback.ts';
import { gmailFilterXml } from './filters.ts';
import { GoogleError, hasControl, ownedName, type GmailClient } from './gmail.ts';
import { newEtag, shortId } from './ids.ts';
import {
  CLEF,
  CLEF_FLASH,
  DAILY_WRITE_LIMIT_MAX,
  DAY,
  DESCRIPTION_MAX,
  DISPLAY_NAME_MAX,
  FLASH_SWITCH_SHARE,
  ID_PATTERN,
  LABEL_ID_PATTERN,
  LABEL_PREFIX,
  LABELS_MAX,
  NEURON_BUDGET_MAX,
  NEURON_BUDGET_MIN,
  NONE,
  PAGE,
  RULE_PAGE,
  RULES_MAX,
  RUN_WRITE_LIMIT_MAX,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  UNDO_BATCH,
  UNDO_RANGE_MAX_MS,
} from './limits.ts';
import { exampleMessage, labelMessage, labelName, ledgerMessage, MODES, modeName, reviewMessage, RULE_KINDS, ruleMessage } from './model.ts';
import { REASONS, sortError } from './reasons.ts';
import { authState, type Budget, writeScope } from './session.ts';
import { effectiveMode, readSettings, writeSettings, type SettingsValue } from './settings.ts';
import { utcDay, type DecisionRow, type LabelRow, type LedgerRow, type ReviewRow, type RuleRow, type Store } from './store.ts';
import { ensureGmailLabel, executeWrites, intend, intendUndo, type WriteContext } from './writes.ts';

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

function writeContext(ctx: ApiContext, gmail: GmailClient): WriteContext {
  return { store: ctx.store, gmail, budget: ctx.budget, now: () => ctx.now, transact: ctx.transact };
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
  return labelMessage(row, ctx.store.exampleCounts().get(row.id) ?? 0);
}

function checkDisplayName(name: string): string {
  const value = name.trim();
  if (value === '' || Array.from(value).length > DISPLAY_NAME_MAX || value.includes('/') || hasControl(value) || !ownedName(`${LABEL_PREFIX}${value}`)) throw sortError('INVALID_LABEL');
  return value;
}

function checkThreshold(value: number): number {
  if (value !== 0 && (!Number.isFinite(value) || value < THRESHOLD_MIN || value > THRESHOLD_MAX)) throw sortError('INVALID_SETTINGS');
  return value;
}

function checkDescription(text: string): string {
  if (Array.from(text).length > DESCRIPTION_MAX) throw sortError('INVALID_LABEL');
  return text.trim();
}

function labelEtag(ctx: ApiContext, row: LabelRow, etag: string): void {
  if (etag !== '' && etag !== row.etag) throw sortError('ETAG_MISMATCH', [{ schema: LabelSchema, message: labelOut(ctx, row) }]);
}

// ---- review ----------------------------------------------------------------------------------------------------------------

function pendingItem(ctx: ApiContext, name: string): { item: ReviewRow; decision: DecisionRow } {
  const item = ctx.store.review(idOf(name, 'reviewItems')) ?? notFound();
  if (item.state !== 'pending') throw sortError('ALREADY_RESOLVED');
  const decision = ctx.store.decision(item.message_id);
  if (decision === undefined) throw sortError('ALREADY_RESOLVED');
  return { item, decision };
}

/** The ledger row of mailsort's standing label on a mail, if any. */
function standing(ctx: ApiContext, decision: DecisionRow): LedgerRow | undefined {
  if (decision.outcome !== 'applied' || decision.label_id === null) return undefined;
  const row = ctx.store.one<LedgerRow>(`SELECT * FROM ledger WHERE message_id = ? AND label_id = ? AND state = 'applied' AND superseded = 0 ORDER BY create_time DESC LIMIT 1`, decision.message_id, decision.label_id);
  return row;
}

/** Records the owner's choice and the Gmail writes it implies (live mode only); answers the ledger rows to run. */
function choose(ctx: ApiContext, item: ReviewRow, decision: DecisionRow, chosen: string | null): string[] {
  const { store } = ctx;
  setVerdict(store, decision, chosen, 'review', ctx.now);
  // setVerdict resolves the item through pendingReviewOf; an audit item is the one asked about.
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
    if (label !== undefined && label.gmail_state !== 'missing') {
      // The decision keeps its own label and outcome (the accuracy is about the decision); the ledger row is the owner's.
      ids.push(intend(store, decision.message_id, label, true, 'owner', ctx.now));
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
    defaultThreshold: value.defaultThreshold,
    precisionTarget: value.precisionTarget,
    breakerTripped: value.breaker !== '',
    breakerReason: value.breaker,
    etag: value.etag,
  });
}

function integer(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw sortError('INVALID_SETTINGS');
  return value;
}

function fraction(value: number): number {
  if (!Number.isFinite(value) || value < THRESHOLD_MIN || value > THRESHOLD_MAX) throw sortError('INVALID_SETTINGS');
  return value;
}

// ---- rules ----------------------------------------------------------------------------------------------------------------

const KIND_NAMES = new Map<number, RuleRow['kind']>(Object.entries(RULE_KINDS).map(([name, value]) => [value, name as RuleRow['kind']]));

function checkRuleValue(kind: RuleRow['kind'], raw: string): string {
  const value = raw.trim().toLowerCase();
  const ok =
    kind === 'sender_domain'
      ? /^(?=.{3,200}$)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(value)
      : kind === 'list_id'
        ? /^[\x21-\x7e]{3,200}$/.test(value) && !/[<>]/.test(value)
        : /^(?=.{3,200}$)[^\s@<>]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value);
  if (!ok) throw sortError('INVALID_RULE');
  return value;
}

function ruleOut(ctx: ApiContext, row: RuleRow): ReturnType<typeof ruleMessage> {
  return ruleMessage(row, ctx.store.label(row.label_id)?.trust === 1);
}

// ---- the handlers ----------------------------------------------------------------------------------------------------------

export const handlers: ServiceHandlers<ShapeOf<typeof MailsortUiService>, ApiContext> = {
  // labels

  listLabels(request, ctx) {
    const size = pageSize(request.pageSize, PAGE);
    const after = cursorOf(request.pageToken, {}, numberCursor) ?? -1;
    const rows = ctx.store.all<LabelRow>(`SELECT * FROM labels WHERE seq > ? ORDER BY seq LIMIT ?`, after, size + 1);
    const page = rows.slice(0, size);
    const counts = ctx.store.exampleCounts();
    const last = page[page.length - 1];
    return Promise.resolve(
      create(ListLabelsResponseSchema, {
        labels: page.map((row) => labelMessage(row, counts.get(row.id) ?? 0)),
        nextPageToken: rows.length > size && last !== undefined ? encodePageToken(last.seq, {}) : '',
      }),
    );
  },

  getLabel(request, ctx) {
    return Promise.resolve(labelOut(ctx, existingLabel(ctx, idOf(request.name, 'labels'))));
  },

  async createLabel(request, ctx) {
    const id = request.labelId === '' ? shortId('l') : request.labelId;
    if (!LABEL_ID_PATTERN.test(id) || id === NONE) throw sortError('INVALID_LABEL');
    const label = request.label ?? bad('label is required');
    const displayName = checkDisplayName(label.displayName);
    const description = checkDescription(label.description);
    const threshold = checkThreshold(label.threshold);
    const created = once(ctx, request.requestId, 'CreateLabel', `labels/${id}`, LabelSchema, () => {
      const { store } = ctx;
      if (store.label(id) !== undefined || store.one(`SELECT 1 AS x FROM labels WHERE display_name = ?`, displayName) !== undefined) throw sortError('LABEL_EXISTS');
      if (store.count(`SELECT count(*) AS n FROM labels`) >= LABELS_MAX) throw sortError('LIMIT_REACHED');
      const seq = (store.one<{ seq: number | null }>(`SELECT max(seq) AS seq FROM labels`)?.seq ?? 0) + 1;
      store.run(
        `INSERT INTO labels (id, seq, display_name, description, enabled, live, trust, threshold, gmail_state, desc_version, live_since, create_time, update_time, etag)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?)`,
        id,
        seq,
        displayName,
        description,
        label.enabled ? 1 : 0,
        label.live ? 1 : 0,
        label.trustImplying ? 1 : 0,
        threshold,
        label.live ? ctx.now : null,
        ctx.now,
        ctx.now,
        newEtag(ctx.now),
      );
      return labelOut(ctx, existingLabel(ctx, id));
    });
    // In live mode with a write grant the label is created in Gmail at once; otherwise before its first write.
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
    const displayName = has('display_name') ? checkDisplayName(label.displayName) : before.display_name;
    const description = has('description') ? checkDescription(label.description) : before.description;
    const threshold = has('threshold') ? checkThreshold(label.threshold) : before.threshold;
    return onceAsync(ctx, request.requestId, 'UpdateLabel', `labels/${id}`, LabelSchema, async () => {
      if (displayName !== before.display_name) {
        if (ctx.store.one(`SELECT 1 AS x FROM labels WHERE display_name = ? AND id != ?`, displayName, id) !== undefined) throw sortError('LABEL_EXISTS');
        if (before.gmail_state === 'linked' && before.gmail_id !== null) {
          // A linked label is renamed in Gmail first: its name is how the owner sees it there.
          if (!writeScope(ctx.store) || effectiveMode(readSettings(ctx.store), ctx.ceiling) === 'off') throw sortError('GMAIL_WRITE_NOT_ALLOWED');
          const client = await gmailFor(ctx);
          try {
            await client.renameLabel(before.gmail_id, `${LABEL_PREFIX}${displayName}`);
          } catch (error) {
            throw gmailError(error);
          }
        }
      }
      return ctx.transact(() => {
        const { store } = ctx;
        const live = has('live') ? label.live : before.live === 1;
        store.run(
          `UPDATE labels SET display_name = ?, description = ?, enabled = ?, live = ?, trust = ?, threshold = ?, desc_version = desc_version + ?,
             live_since = ?, update_time = ?, etag = ? WHERE id = ?`,
          displayName,
          description,
          (has('enabled') ? label.enabled : before.enabled === 1) ? 1 : 0,
          live ? 1 : 0,
          (has('trust_implying') ? label.trustImplying : before.trust === 1) ? 1 : 0,
          threshold,
          description !== before.description ? 1 : 0,
          live ? (before.live === 1 ? before.live_since : ctx.now) : null,
          ctx.now,
          newEtag(ctx.now),
          id,
        );
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
        store.run(`DELETE FROM rules WHERE label_id = ?`, id);
        deleteExamplesOfLabel(store, id);
        store.run(`UPDATE ledger SET state = 'failed', last_code = 'label_deleted' WHERE label_id = ? AND state = 'intended'`, id);
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
        const ours = gmailLabels.filter((label) => ownedName(label.name) && /^Label_[0-9]+$/.test(label.id));
        const byName = new Map(ours.map((label) => [label.name.slice(LABEL_PREFIX.length), label]));
        const ids = new Set(ours.map((label) => label.id));
        let linked = 0;
        let imported = 0;
        let missing = 0;
        for (const row of store.labels()) {
          const match = byName.get(row.display_name);
          if (match !== undefined && (row.gmail_state !== 'linked' || row.gmail_id !== match.id)) {
            store.run(`UPDATE labels SET gmail_id = ?, gmail_state = 'linked' WHERE id = ?`, match.id, row.id);
            store.touchLabel(row.id, ctx.now);
            linked++;
          } else if (match === undefined && row.gmail_state === 'linked' && row.gmail_id !== null && !ids.has(row.gmail_id)) {
            store.run(`UPDATE labels SET gmail_state = 'missing' WHERE id = ?`, row.id);
            store.touchLabel(row.id, ctx.now);
            missing++;
          }
          byName.delete(row.display_name);
        }
        for (const [leaf, label] of byName) {
          if (store.count(`SELECT count(*) AS n FROM labels`) >= LABELS_MAX) break;
          if (store.one(`SELECT 1 AS x FROM labels WHERE gmail_id = ?`, label.id) !== undefined) continue;
          if (leaf.trim() === '' || Array.from(leaf).length > DISPLAY_NAME_MAX) continue;
          const seq = (store.one<{ seq: number | null }>(`SELECT max(seq) AS seq FROM labels`)?.seq ?? 0) + 1;
          store.run(
            `INSERT INTO labels (id, seq, display_name, description, enabled, live, trust, threshold, gmail_id, gmail_state, create_time, update_time, etag)
             VALUES (?, ?, ?, '', 0, 0, 0, 0, ?, 'linked', ?, ?, ?)`,
            shortId('l'),
            seq,
            leaf,
            label.id,
            ctx.now,
            ctx.now,
            newEtag(ctx.now),
          );
          imported++;
        }
        const counts = store.exampleCounts();
        return create(SyncLabelsResponseSchema, {
          labels: store.labels().map((row) => labelMessage(row, counts.get(row.id) ?? 0)),
          linkedCount: linked,
          importedCount: imported,
          missingCount: missing,
        });
      });
    });
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

  async confirmReviewItem(request, ctx) {
    const id = idOf(request.name, 'reviewItems');
    let ids: string[] = [];
    const answer = once(ctx, request.requestId, 'ConfirmReviewItem', `reviewItems/${id}`, ReviewItemSchema, () => {
      const { item, decision } = pendingItem(ctx, request.name);
      if (item.suggested_label === null) bad('the item has no suggested label: correct it instead');
      ids = choose(ctx, item, decision, item.suggested_label);
      return reviewMessage(ctx.store.review(id) ?? notFound());
    });
    await flush(ctx, ids);
    return answer;
  },

  async correctReviewItem(request, ctx) {
    const id = idOf(request.name, 'reviewItems');
    const chosen = request.label === '' ? null : idOf(request.label, 'labels');
    let ids: string[] = [];
    const answer = once(ctx, request.requestId, 'CorrectReviewItem', `reviewItems/${id}`, ReviewItemSchema, () => {
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

  // rules

  listRules(request, ctx) {
    const size = pageSize(request.pageSize, RULE_PAGE);
    const after = cursorOf(request.pageToken, {}, (cursor) => (Array.isArray(cursor) && typeof cursor[0] === 'number' && typeof cursor[1] === 'string' ? ([cursor[0], cursor[1]] as const) : null));
    const rows = after === null
      ? ctx.store.all<RuleRow>(`SELECT * FROM rules ORDER BY create_time DESC, id DESC LIMIT ?`, size + 1)
      : ctx.store.all<RuleRow>(`SELECT * FROM rules WHERE create_time < ? OR (create_time = ? AND id < ?) ORDER BY create_time DESC, id DESC LIMIT ?`, after[0], after[0], after[1], size + 1);
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return Promise.resolve(
      create(ListRulesResponseSchema, {
        rules: page.map((row) => ruleOut(ctx, row)),
        nextPageToken: rows.length > size && last !== undefined ? encodePageToken([last.create_time, last.id], {}) : '',
      }),
    );
  },

  getRule(request, ctx) {
    return Promise.resolve(ruleOut(ctx, ctx.store.rule(idOf(request.name, 'rules')) ?? notFound()));
  },

  createRule(request, ctx) {
    const rule = request.rule ?? bad('rule is required');
    const kind = rule.kind === Rule_Kind.UNSPECIFIED ? undefined : KIND_NAMES.get(rule.kind);
    if (kind === undefined) throw sortError('INVALID_RULE');
    const value = checkRuleValue(kind, rule.value);
    const label = idOf(rule.label, 'labels');
    const id = request.ruleId === '' ? shortId('r') : request.ruleId;
    if (!LABEL_ID_PATTERN.test(id)) throw sortError('INVALID_RULE');
    return Promise.resolve(
      once(ctx, request.requestId, 'CreateRule', `rules/${id}`, RuleSchema, () => {
        const { store } = ctx;
        existingLabel(ctx, label);
        if (store.rule(id) !== undefined || store.one(`SELECT 1 AS x FROM rules WHERE kind = ? AND value = ? AND label_id = ?`, kind, value, label) !== undefined) throw sortError('INVALID_RULE');
        if (store.count(`SELECT count(*) AS n FROM rules`) >= RULES_MAX) throw sortError('LIMIT_REACHED');
        store.run(`INSERT INTO rules (id, kind, value, label_id, state, create_time, update_time) VALUES (?, ?, ?, ?, 'active', ?, ?)`, id, kind, value, label, ctx.now, ctx.now);
        return ruleOut(ctx, store.rule(id) ?? notFound());
      }),
    );
  },

  approveRule(request, ctx) {
    const id = idOf(request.name, 'rules');
    return Promise.resolve(
      once(ctx, request.requestId, 'ApproveRule', `rules/${id}`, RuleSchema, () => {
        const row = ctx.store.rule(id) ?? notFound();
        if (row.state !== 'active') ctx.store.run(`UPDATE rules SET state = 'active', update_time = ? WHERE id = ?`, ctx.now, id);
        return ruleOut(ctx, ctx.store.rule(id) ?? notFound());
      }),
    );
  },

  disableRule(request, ctx) {
    const id = idOf(request.name, 'rules');
    return Promise.resolve(
      once(ctx, request.requestId, 'DisableRule', `rules/${id}`, RuleSchema, () => {
        const row = ctx.store.rule(id) ?? notFound();
        if (row.state !== 'disabled') ctx.store.run(`UPDATE rules SET state = 'disabled', update_time = ? WHERE id = ?`, ctx.now, id);
        return ruleOut(ctx, ctx.store.rule(id) ?? notFound());
      }),
    );
  },

  deleteRule(request, ctx) {
    const id = idOf(request.name, 'rules');
    return Promise.resolve(
      once(ctx, request.requestId, 'DeleteRule', `rules/${id}`, EmptySchema, () => {
        if (ctx.store.run(`DELETE FROM rules WHERE id = ?`, id) === 0) notFound();
        return create(EmptySchema, {});
      }),
    );
  },

  exportGmailFilters(_request, ctx) {
    const rows = ctx.store.all<RuleRow & { display_name: string; trust: number }>(
      `SELECT r.*, l.display_name, l.trust FROM rules r JOIN labels l ON l.id = r.label_id WHERE r.state = 'active' ORDER BY r.create_time, r.id`,
    );
    const exported = rows.filter((row) => row.trust === 0);
    return Promise.resolve(
      create(ExportGmailFiltersResponseSchema, {
        xml: gmailFilterXml(exported.map((row) => ({ kind: row.kind, value: row.value, labelName: row.display_name })), ctx.now),
        ruleCount: exported.length,
        skippedCount: rows.length - exported.length,
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
    const before = cursorOf(request.pageToken, {}, stringCursor) ?? '￿';
    const rows = ctx.store.all<LedgerRow>(`SELECT * FROM ledger WHERE id < ? ORDER BY id DESC LIMIT ?`, before, size + 1);
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return Promise.resolve(create(ListLedgerEntriesResponseSchema, { ledgerEntries: page.map(ledgerMessage), nextPageToken: rows.length > size && last !== undefined ? encodePageToken(last.id, {}) : '' }));
  },

  getLedgerEntry(request, ctx) {
    return Promise.resolve(ledgerMessage(ctx.store.ledgerRow(idOf(request.name, 'ledgerEntries')) ?? notFound()));
  },

  async undoLedgerEntry(request, ctx) {
    const id = idOf(request.name, 'ledgerEntries');
    return onceAsync(ctx, request.requestId, 'UndoLedgerEntry', `ledgerEntries/${id}`, LedgerEntrySchema, async () => {
      const row = ctx.store.ledgerRow(id) ?? notFound();
      if (!(row.state === 'applied' || row.state === 'undo_intended') || row.superseded === 1) throw sortError('NOT_UNDOABLE');
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
      return ledgerMessage(after);
    });
  },

  async undoLedgerEntries(request, ctx) {
    const start = request.startTime === undefined ? NaN : timestampMs(request.startTime);
    const end = request.endTime === undefined ? NaN : timestampMs(request.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > UNDO_RANGE_MAX_MS) bad('the range is not valid (at most 31 days)');
    return onceAsync(ctx, request.requestId, 'UndoLedgerEntries', 'ledgerEntries', UndoLedgerEntriesResponseSchema, async () => {
      if (!writeScope(ctx.store)) throw sortError('GMAIL_WRITE_NOT_ALLOWED');
      const client = await gmailFor(ctx);
      const range = `FROM ledger WHERE state = 'applied' AND superseded = 0 AND create_time >= ? AND create_time < ?`;
      const rows = ctx.store.all<LedgerRow>(`SELECT * ${range} ORDER BY id DESC LIMIT ?`, start, end, UNDO_BATCH);
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
      return create(UndoLedgerEntriesResponseSchema, { undoneCount: undone, failedCount: failed, remainingCount: ctx.store.count(`SELECT count(*) AS n ${range}`, start, end) });
    });
  },

  // singletons

  getAccuracyReport(request, ctx) {
    if (request.name !== 'accuracyReport') notFound();
    const labels = ctx.store.labels();
    const stats = labelStats(ctx.store, labels.map((label) => label.id), ctx.now);
    const settings = readSettings(ctx.store);
    const week = ctx.store.one<{ decided: number; unsure: number | null }>(
      `SELECT count(*) AS decided, sum(outcome = 'unsure') AS unsure FROM decisions WHERE decided_at >= ? AND outcome != 'skipped'`,
      ctx.now - 7 * DAY,
    );
    const decided = week?.decided ?? 0;
    const unsure = week?.unsure ?? 0;
    return Promise.resolve(
      create(AccuracyReportSchema, {
        name: 'accuracyReport',
        labels: labels.map((label) => {
          const s = stats.get(label.id);
          return create(LabelAccuracySchema, {
            label: labelName(label.id),
            confirmedCount: (s?.confirmed ?? 0) + (s?.weak ?? 0),
            correctedCount: s?.corrected ?? 0,
            precisionLowerBound: s?.lowerBound ?? 0,
            decidedCount: s?.decided7d ?? 0,
            appliedCount: s?.applied7d ?? 0,
          });
        }),
        decidedCount: decided,
        unsureCount: unsure,
        coverage: decided === 0 ? 0 : (decided - unsure) / decided,
        precisionTarget: settings.precisionTarget,
      }),
    );
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
        else if (path === 'default_threshold') next = { ...next, defaultThreshold: fraction(input.defaultThreshold) };
        else if (path === 'precision_target') next = { ...next, precisionTarget: fraction(input.precisionTarget) };
        else if (!['name', 'etag', 'effective_mode', 'breaker_tripped', 'breaker_reason'].includes(path)) bad('update_mask names an unknown field');
      }
      return settingsMessage(ctx, writeSettings(ctx.store, next, ctx.now));
    });
    await ctx.wake();
    return answer;
  },
};
