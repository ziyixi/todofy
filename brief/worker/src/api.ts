/**
 * The owner API (proto/brief/ui/v1): one handler per rpc of BriefUiService, served by the shared transcoder inside
 * BriefState (state.ts), after the Worker authenticated the owner and checked Origin and CSRF (http.ts). Nothing here
 * calls a model, fetches a source or sends an email: every method reads or writes the object's own SQLite. A mutation
 * and its AIP-155 request log entry are one transaction.
 */
import { ListIssuesResponseSchema, ListItemsResponseSchema, ListSourcesResponseSchema, type BriefUiService } from '@ziyixi/proto/brief/ui/v1/brief_ui_service_pb';
import { Item_Vote, ItemSchema } from '@ziyixi/proto/brief/ui/v1/issue_pb';
import { ProfileSchema, ServiceStatusSchema, SettingsSchema, type Settings } from '@ziyixi/proto/brief/ui/v1/status_pb';
import { FieldMaskError, updatePaths } from '@ziyixi/proto/field-mask';
import type { ServiceHandlers, ShapeOf } from '@ziyixi/proto/http-transcoder';
import { decodePageToken, encodePageToken, PageTokenError, type PageParameters } from '@ziyixi/proto/page-token';
import { create, type DescMessage, type JsonValue, type MessageShape } from '@ziyixi/proto/protobuf';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { resumeCalls } from './claude.ts';
import type { Env } from './env.ts';
import { resetProfile } from './learn.ts';
import { ISSUES_PAGE, ISSUES_PAGE_MAX, ITEMS_PAGE, MONTHLY_BUDGET_MAX, MONTHLY_BUDGET_MIN, SOURCES_PAGE } from './limits.ts';
import { buildingIssue, issueMessage, itemMessage, profileMessage, sourceMessage, sourceMessages, sourceWeights } from './model.ts';
import { briefError, type Reason } from './reasons.ts';
import type { Registry, Topic } from './registry.ts';
import { issueTitle } from './render.ts';
import { readSettings, writeSettings, type SettingsState } from './settings.ts';
import { serviceStatus } from './status.ts';
import type { IssueItemRow, IssueRow, RunRow, SourceRow, Store } from './store.ts';

/** What every handler gets from BriefState. */
export interface ApiContext {
  readonly store: Store;
  readonly registry: Registry;
  readonly topics: readonly Topic[];
  readonly env: Env;
  readonly now: number;
  readonly build: string;
  readonly transact: <T>(fn: () => T) => T;
  /** Brings the alarm forward (a resume, an unpause). */
  readonly wake: () => Promise<void>;
  readonly alarmAt: () => Promise<number | null>;
}

const SETTINGS_FIELDS = new Set(['name', 'paused', 'monthly_budget_usd', 'etag']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ITEM_ID = /^(?:[rw]\d{1,2}|deep)$/;

function bad(message: string): never {
  throw briefError('BAD_REQUEST', [], message);
}

function fail(reason: Reason): never {
  throw briefError(reason);
}

function pageSize(value: number, fallback: number, max: number): number {
  if (value < 0) bad('page_size is negative');
  return value === 0 ? fallback : Math.min(value, max);
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

function issueName(name: string): string {
  const date = name.startsWith('issues/') ? name.slice('issues/'.length) : '';
  if (!DATE.test(date)) bad('not an issue name');
  return date;
}

function itemName(name: string): { issue: string; item: string } {
  const parts = name.split('/');
  if (parts.length !== 4 || parts[0] !== 'issues' || parts[2] !== 'items' || !DATE.test(parts[1] ?? '') || !ITEM_ID.test(parts[3] ?? '')) bad('not an item name');
  return { issue: parts[1] ?? '', item: parts[3] ?? '' };
}

/** A mutation once per request_id: the mutation and its log entry are one transaction. */
function once<Desc extends DescMessage>(ctx: ApiContext, requestId: string, method: string, resource: string, schema: Desc, run: () => MessageShape<Desc>): MessageShape<Desc> {
  return ctx.transact(() => {
    if (requestId !== '') {
      const logged = ctx.store.request(requestId, ctx.now);
      if (logged !== undefined) {
        if (logged.method !== method || logged.resource !== resource) bad('the request_id was used for another request (another method or resource)');
        return fromWire(schema, JSON.parse(logged.answer) as unknown).message;
      }
    }
    const answer = run();
    if (requestId !== '') ctx.store.putRequest(requestId, method, resource, JSON.stringify(toWire(schema, answer)), ctx.now);
    return answer;
  });
}

function settingsMessage(state: SettingsState): Settings {
  return create(SettingsSchema, { name: 'settings', paused: state.paused, monthlyBudgetUsd: state.monthlyBudgetUsd, etag: state.etag });
}

function vote(store: Store, issue: string, item: string): { vote: string; ms: number } | undefined {
  return store.one<{ vote: string; ms: number }>(`SELECT vote, ms FROM votes WHERE issue = ? AND item = ? AND origin = 'owner'`, issue, item);
}

/** Records the owner's vote on an item (the archive's buttons and the email's links), replacing an earlier one. */
export function recordVote(store: Store, issue: string, item: string, value: 'up' | 'down' | 'more', now: number): IssueItemRow | null {
  const row = store.one<IssueItemRow>(`SELECT * FROM issue_items WHERE issue = ? AND id = ?`, issue, item);
  if (row === undefined) return null;
  store.run(`INSERT INTO votes (issue, item, origin, vote, ms) VALUES (?, ?, 'owner', ?, ?) ON CONFLICT (issue, item, origin) DO UPDATE SET vote = excluded.vote, ms = excluded.ms`, issue, item, value, now);
  // A voted item's embeddings are kept 90 days (design §14).
  for (const key of JSON.parse(row.keys) as string[]) store.run(`UPDATE embeddings SET voted = 1 WHERE item = (SELECT rowid FROM items WHERE key = ?)`, key);
  return row;
}

export const handlers: ServiceHandlers<ShapeOf<typeof BriefUiService>, ApiContext> = {
  getIssue(request, ctx) {
    const date = issueName(request.name);
    const row = ctx.store.one<IssueRow>(`SELECT * FROM issues WHERE issue = ?`, date);
    if (row !== undefined) return Promise.resolve(issueMessage(ctx.store, row));
    const run = ctx.store.one<RunRow>(`SELECT * FROM runs WHERE issue = ?`, date) ?? fail('NOT_FOUND');
    return Promise.resolve(buildingIssue(run, issueTitle(date, null, null)));
  },

  listIssues(request, ctx) {
    const size = pageSize(request.pageSize, ISSUES_PAGE, ISSUES_PAGE_MAX);
    const before = cursorOf(request.pageToken, {}, (cursor) => (typeof cursor === 'string' && DATE.test(cursor) ? cursor : null));
    const rows = ctx.store.all<IssueRow>(`SELECT * FROM issues WHERE issue < ? ORDER BY issue DESC LIMIT ?`, before ?? '9999-12-31', size + 1);
    const building = before === null ? ctx.store.all<RunRow>(`SELECT * FROM runs WHERE done = 0 AND issue NOT IN (SELECT issue FROM issues) ORDER BY issue DESC LIMIT 2`) : [];
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return Promise.resolve(
      create(ListIssuesResponseSchema, {
        issues: [...building.map((run) => buildingIssue(run, issueTitle(run.issue, null, null))), ...page.map((row) => issueMessage(ctx.store, row))],
        nextPageToken: rows.length > size && last !== undefined ? encodePageToken(last.issue, {}) : '',
      }),
    );
  },

  getItem(request, ctx) {
    const { issue, item } = itemName(request.name);
    const row = ctx.store.one<IssueItemRow>(`SELECT * FROM issue_items WHERE issue = ? AND id = ?`, issue, item) ?? fail('NOT_FOUND');
    return Promise.resolve(itemMessage(row, vote(ctx.store, issue, item)));
  },

  listItems(request, ctx) {
    const issue = issueName(request.parent);
    const size = pageSize(request.pageSize, ITEMS_PAGE, ITEMS_PAGE);
    const after = cursorOf(request.pageToken, { parent: request.parent }, (cursor) => (typeof cursor === 'number' && Number.isInteger(cursor) ? cursor : null));
    if (ctx.store.one(`SELECT 1 AS x FROM issues WHERE issue = ? UNION SELECT 1 AS x FROM runs WHERE issue = ?`, issue, issue) === undefined) fail('NOT_FOUND');
    const rows = ctx.store.all<IssueItemRow>(`SELECT * FROM issue_items WHERE issue = ? AND position > ? ORDER BY position LIMIT ?`, issue, after ?? -1, size + 1);
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return Promise.resolve(
      create(ListItemsResponseSchema, {
        items: page.map((row) => itemMessage(row, vote(ctx.store, issue, row.id))),
        nextPageToken: rows.length > size && last !== undefined ? encodePageToken(last.position, { parent: request.parent }) : '',
      }),
    );
  },

  voteItem(request, ctx) {
    const { issue, item } = itemName(request.name);
    const value = request.vote === Item_Vote.UP ? 'up' : request.vote === Item_Vote.DOWN ? 'down' : request.vote === Item_Vote.MORE ? 'more' : bad('vote is required');
    return Promise.resolve(
      once(ctx, request.requestId, 'VoteItem', request.name, ItemSchema, () => {
        const row = recordVote(ctx.store, issue, item, value, ctx.now) ?? fail('NOT_FOUND');
        return itemMessage(row, { vote: value, ms: ctx.now });
      }),
    );
  },

  getSource(request, ctx) {
    const id = request.name.startsWith('sources/') ? request.name.slice('sources/'.length) : '';
    const source = ctx.registry.byId.get(id) ?? fail('NOT_FOUND');
    const row = ctx.store.one<SourceRow>(`SELECT * FROM sources WHERE id = ?`, id);
    return Promise.resolve(sourceMessage(source, row, sourceWeights(ctx.store, ctx.now).get(id), ctx.now));
  },

  listSources(request, ctx) {
    const size = pageSize(request.pageSize, SOURCES_PAGE, SOURCES_PAGE);
    const after = cursorOf(request.pageToken, {}, (cursor) => (typeof cursor === 'number' && Number.isInteger(cursor) ? cursor : null)) ?? 0;
    const all = sourceMessages(ctx.store, ctx.registry, ctx.now);
    const page = all.slice(after, after + size);
    return Promise.resolve(create(ListSourcesResponseSchema, { sources: page, nextPageToken: after + size < all.length ? encodePageToken(after + size, {}) : '' }));
  },

  getProfile(request, ctx) {
    if (request.name !== 'profile') fail('NOT_FOUND');
    return Promise.resolve(profileMessage(ctx.store, ctx.topics, ctx.now));
  },

  resetProfile(request, ctx) {
    if (request.name !== 'profile') fail('NOT_FOUND');
    return Promise.resolve(
      once(ctx, request.requestId, 'ResetProfile', 'profile', ProfileSchema, () => {
        resetProfile(ctx.store, ctx.now);
        return profileMessage(ctx.store, ctx.topics, ctx.now);
      }),
    );
  },

  getSettings(request, ctx) {
    if (request.name !== 'settings') fail('NOT_FOUND');
    return Promise.resolve(settingsMessage(readSettings(ctx.store)));
  },

  async updateSettings(request, ctx) {
    const input = request.settings ?? bad('settings is required');
    if (input.name !== '' && input.name !== 'settings') fail('NOT_FOUND');
    let paths: '*' | readonly string[];
    try {
      paths = updatePaths(request.updateMask);
    } catch (error) {
      if (error instanceof FieldMaskError) bad('update_mask is not valid');
      throw error;
    }
    // An explicit mask only: a client that leaves a field out must never unpause the brief or change its budget.
    if (paths === '*') bad('update_mask must name the fields to change');
    for (const path of paths) if (!SETTINGS_FIELDS.has(path)) bad('update_mask names an unknown field');
    const budget = paths.includes('monthly_budget_usd') ? input.monthlyBudgetUsd : undefined;
    if (budget !== undefined && (!Number.isFinite(budget) || budget < MONTHLY_BUDGET_MIN || budget > MONTHLY_BUDGET_MAX)) fail('INVALID_SETTINGS');
    const paused = paths.includes('paused') ? input.paused : undefined;
    const answer = once(ctx, request.requestId, 'UpdateSettings', 'settings', SettingsSchema, () => {
      const current = readSettings(ctx.store);
      if (input.etag !== '' && input.etag !== current.etag) throw briefError('ETAG_MISMATCH', [{ schema: SettingsSchema, message: settingsMessage(current) }]);
      if (paused === undefined && budget === undefined) return settingsMessage(current);
      return settingsMessage(writeSettings(ctx.store, { ...(paused === undefined ? {} : { paused }), ...(budget === undefined ? {} : { monthlyBudgetUsd: budget }) }, ctx.now));
    });
    if (paused === false || budget !== undefined) await ctx.wake();
    return answer;
  },

  async getServiceStatus(request, ctx) {
    if (request.name !== 'serviceStatus') fail('NOT_FOUND');
    return serviceStatus(ctx.store, ctx.registry, ctx.env, ctx.now, ctx.build, await ctx.alarmAt());
  },

  async resumeModelCalls(request, ctx) {
    if (request.name !== 'serviceStatus') fail('NOT_FOUND');
    once(ctx, request.requestId, 'ResumeModelCalls', 'serviceStatus', ServiceStatusSchema, () => {
      resumeCalls(ctx.store);
      return create(ServiceStatusSchema, { name: 'serviceStatus' });
    });
    await ctx.wake();
    return serviceStatus(ctx.store, ctx.registry, ctx.env, ctx.now, ctx.build, await ctx.alarmAt());
  },
};
