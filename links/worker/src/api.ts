/**
 * The owner API (proto/links/ui/v1): one handler per rpc of LinksUiService, served by the shared transcoder
 * (proto/ts/http-transcoder.ts) from http.ts after authentication. A handler validates what the IDL cannot (the
 * value rules of limits.ts), reads or writes D1 through store.ts and maps rows to messages (model.ts). Errors are
 * RpcErrors with a reason of links.ui.v1.ErrorReason or common.errors.v1.CommonReason; REASONS gives each its
 * google.rpc.Code and its copy. Only a failed D1 call is UNAVAILABLE (`dependency`); anything else a handler throws
 * is a bug, answered INTERNAL by the transcoder.
 */
import type { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb';
import { updatePaths } from '@ziyixi/proto/field-mask';
import { FilterError, parseLiteralFilter } from '@ziyixi/proto/filter';
import type { ServiceHandlers, ShapeOf } from '@ziyixi/proto/http-transcoder';
import type { ErrorReason } from '@ziyixi/proto/links/ui/v1/errors_pb';
import { Link_PathMode, Link_Visibility, LinkSchema, type Link } from '@ziyixi/proto/links/ui/v1/link_pb';
import {
  ExportLinksResponseSchema,
  ImportLinksResponseSchema,
  ImportProblem_Reason,
  ListLinkRevisionsResponseSchema,
  ListLinksResponseSchema,
  type ImportLinksResponse,
  type LinksUiService,
} from '@ziyixi/proto/links/ui/v1/links_ui_service_pb';
import { decodePageToken, encodePageToken, PageTokenError } from '@ziyixi/proto/page-token';
import { create, type DescMessage, type MessageShape } from '@ziyixi/proto/protobuf';
import { timestampMs } from '@ziyixi/proto/protobuf/wkt';
import { Code, errorDetail, RpcError } from '@ziyixi/proto/rpc-status';
import { fromWire, toWire, WireJsonError } from '@ziyixi/proto/wire-json';
import { publicHost, type Env } from './env.ts';
import { asciiLower, normalizeKey } from './keys.ts';
import {
  DESCRIPTION_MAX,
  EXPORT_PAGE,
  FILTER_LITERALS_MAX,
  FILTER_MAX,
  IMPORT_CHARS_MAX,
  IMPORT_LINES_MAX,
  KEY_PATTERN,
  LIST_PAGE,
  REVISIONS_KEPT,
  TAG_PATTERN,
  TAGS_MAX,
} from './limits.ts';
import { linkMessage, linkWire, type LinkContent, type LinkRow } from './model.ts';
import * as store from './store.ts';
import { checkTarget, type PathMode } from './targets.ts';

/** What every handler gets (http.ts authenticated the owner before routing). */
export interface ApiContext {
  readonly env: Env;
  /** The request's time (epoch milliseconds). */
  readonly now: number;
}

/** An ErrorInfo reason the links API answers: its own (links.ui.v1.ErrorReason) or one every API shares. */
export type Reason = Exclude<keyof typeof ErrorReason | keyof typeof CommonReason, 'UNSPECIFIED'>;

/**
 * Each reason's code (errors.proto lists the same), its developer message and its user-facing copy (the
 * LocalizedMessage). Exhaustive: a new ErrorReason fails the typecheck until it is mapped here.
 */
export const REASONS: Readonly<Record<Reason, { readonly code: Code; readonly message: string; readonly zh: string }>> = {
  UNAUTHORIZED: { code: Code.UNAUTHENTICATED, message: 'no valid Cloudflare Access login for the owner', zh: '未登录或凭据无效' },
  ACCESS_NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'the Access settings are incomplete', zh: 'Cloudflare Access 配置不完整' },
  NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'a required secret is missing', zh: '服务缺少必需的密钥配置' },
  CSRF_FAILED: { code: Code.PERMISSION_DENIED, message: 'the CSRF token or Origin is not valid', zh: '页面安全令牌已失效，请刷新后重试' },
  BAD_REQUEST: { code: Code.INVALID_ARGUMENT, message: 'the request is not valid', zh: '请求格式不正确' },
  NOT_FOUND: { code: Code.NOT_FOUND, message: 'no such resource', zh: '找不到这个短链接' },
  METHOD_NOT_ALLOWED: { code: Code.UNIMPLEMENTED, message: 'this method is not allowed on this path', zh: '不支持该请求方法' },
  UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'the service is unavailable; repeat the request', zh: '服务暂时不可用，请稍后再试' },
  INTERNAL: { code: Code.INTERNAL, message: 'internal error', zh: '服务出错了，请稍后刷新页面' },
  LINK_EXISTS: { code: Code.ALREADY_EXISTS, message: 'a link holds this key', zh: '这个短链接已存在' },
  LINK_DELETED: { code: Code.FAILED_PRECONDITION, message: 'the link is deleted', zh: '这个短链接已删除，请先恢复' },
  NOT_DELETED: { code: Code.ALREADY_EXISTS, message: 'the link is not deleted', zh: '这个短链接没有被删除' },
  ETAG_MISMATCH: { code: Code.ABORTED, message: 'the link changed since the etag', zh: '这个短链接已在别处修改' },
  INVALID_KEY: { code: Code.INVALID_ARGUMENT, message: 'not a valid key', zh: '短链接名只能用小写字母、数字和连字符（不能以连字符开头，最多 63 个字符）' },
  RESERVED_KEY: { code: Code.INVALID_ARGUMENT, message: 'the key is reserved', zh: '这个名字保留给服务自身使用' },
  INVALID_TARGET: { code: Code.INVALID_ARGUMENT, message: 'not a target a link may point to', zh: '目标必须是 https 网址（不含用户名和密码，最多 2048 个字符，不能指向本站）' },
  LINKS_FULL: { code: Code.FAILED_PRECONDITION, message: 'the store holds the most links it may', zh: '短链接数量已达上限' },
  REVISION_NOT_FOUND: { code: Code.NOT_FOUND, message: 'the link has no such kept revision', zh: '找不到这个历史版本' },
};

export function linksError(reason: Reason, current?: LinkRow): RpcError {
  const { code, message } = REASONS[reason];
  return new RpcError(code, reason, message, { details: current === undefined ? [] : [errorDetail(LinkSchema, linkMessage(current))] });
}

export function isReason(value: string): value is Reason {
  return Object.hasOwn(REASONS, value);
}

function bad(): never {
  throw linksError('BAD_REQUEST');
}

/**
 * A call to D1: any failure is UNAVAILABLE, which the client may repeat (with the same request_id). Only these
 * calls are wrapped, so a bug in this code stays INTERNAL.
 */
async function dependency<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw linksError('UNAVAILABLE');
  }
}

// ---- names and values --------------------------------------------------------------------------------------------

/** The key of `links/{link}`: INVALID_KEY for a malformed name, NOT_FOUND for a reserved key (none can exist). */
function keyOf(name: string): string {
  const id = name.startsWith('links/') ? name.slice('links/'.length) : '';
  if (id.includes('/')) throw linksError('INVALID_KEY');
  const normalized = normalizeKey(id);
  if ('key' in normalized) return normalized.key;
  throw linksError(normalized.problem === 'RESERVED_KEY' ? 'NOT_FOUND' : 'INVALID_KEY');
}

const MODES: Readonly<Record<number, PathMode>> = { [Link_PathMode.UNSPECIFIED]: 'exact', [Link_PathMode.EXACT]: 'exact', [Link_PathMode.APPEND]: 'append', [Link_PathMode.TEMPLATE]: 'template' };
const VISIBILITY: Readonly<Record<number, 'private' | 'public'>> = {
  [Link_Visibility.UNSPECIFIED]: 'private',
  [Link_Visibility.PRIVATE]: 'private',
  [Link_Visibility.PUBLIC]: 'public',
};

/** The length of `text` in Unicode code points (a surrogate pair counts once). */
function codePoints(text: string): number {
  return text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '_').length;
}

/** The tags as stored (a JSON array), lower-cased; null when they break the rule (TAGS_MAX distinct TAG_PATTERN). */
function tagsValue(tags: readonly string[]): string | null {
  const lowered = tags.map(asciiLower);
  const valid = lowered.length <= TAGS_MAX && new Set(lowered).size === lowered.length && lowered.every((tag) => TAG_PATTERN.test(tag));
  return valid ? JSON.stringify(lowered) : null;
}

/** Why a link's fields cannot be stored: the target, or another field's value rule. */
type ValueProblem = 'INVALID_TARGET' | 'BAD_REQUEST';

/**
 * The stored content of a link whose fields `paths` are taken from `link` and the rest from `base` (AIP-134; a
 * create passes every field and no base), each checked against its rule. The target is checked against the
 * resulting mode, so a mask that changes only the mode still needs a target that fits it.
 */
function contentOf(link: Link, paths: '*' | readonly string[], base: LinkContent | null, host: string): LinkContent | ValueProblem {
  const take = (field: string) => base === null || paths === '*' || paths.includes(field);
  const mode = take('path_mode') ? MODES[link.pathMode] : base?.path_mode;
  const visibility = take('visibility') ? VISIBILITY[link.visibility] : base?.visibility;
  const tags = take('tags') ? tagsValue(link.tags) : (base?.tags ?? null);
  const description = take('description') ? link.description : (base?.description ?? '');
  if (mode === undefined || visibility === undefined || tags === null || codePoints(description) > DESCRIPTION_MAX) return 'BAD_REQUEST';
  const target = checkTarget(take('target') ? link.target : (base?.target ?? ''), mode, host);
  if (target === null) return 'INVALID_TARGET';
  const expire = take('expire_time') ? (link.expireTime === undefined ? null : timestampMs(link.expireTime)) : (base?.expire_time ?? null);
  return { target, path_mode: mode, visibility, description, tags, expire_time: expire };
}

function contentOrThrow(content: LinkContent | ValueProblem): LinkContent {
  if (typeof content === 'string') throw linksError(content);
  return content;
}

function hostOf(env: Env): string {
  // Without PUBLIC_HOST no target is refused for naming this host; the deploy always sets it (wrangler.toml).
  return publicHost(env) ?? '';
}

/** page_size of a list (AIP-158): 0 means `max`, larger values are read as `max`, negative ones are BAD_REQUEST. */
function pageSize(value: number, max: number): number {
  if (value < 0) bad();
  return value === 0 ? max : Math.min(value, max);
}

/** The cursor of an AIP-158 page token made for `parameters`; BAD_REQUEST for any other string. */
function cursorOf<T>(token: string, parameters: Readonly<Record<string, string | boolean>>, read: (cursor: unknown) => T | null): T | null {
  if (token === '') return null;
  try {
    return read(decodePageToken(token, parameters)) ?? bad();
  } catch (error) {
    if (error instanceof PageTokenError) bad();
    throw error;
  }
}

/** The ASCII-lower-cased literals of a ListLinks filter (proto/ts/filter.ts); BAD_REQUEST outside the subset. */
function filterLiterals(filter: string): string[] {
  if (filter.length > FILTER_MAX) bad();
  try {
    return parseLiteralFilter(filter, FILTER_LITERALS_MAX).map(asciiLower);
  } catch (error) {
    if (error instanceof FilterError) bad();
    throw error;
  }
}

// ---- outcomes -----------------------------------------------------------------------------------------------------

/** The wire bytes a mutation's response is logged as (AIP-155): a repeat of the request ID answers them. */
function wireOf<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): string {
  return JSON.stringify(toWire(schema, message));
}

const respondLink = (row: LinkRow) => wireOf(LinkSchema, linkMessage(row));

/** A store outcome as the rpc's answer: the value built, the logged first response, or the failure's error. */
function settle<Desc extends DescMessage, T>(schema: Desc, outcome: store.Outcome<T>, build: (value: T) => MessageShape<Desc>): MessageShape<Desc> {
  switch (outcome.kind) {
    case 'ok':
      return build(outcome.value);
    case 'replay':
      return fromWire(schema, JSON.parse(outcome.response)).message;
    case 'failed':
      throw linksError(outcome.failure.reason, outcome.failure.current);
  }
}

function writeContext(env: Env, now: number, requestId: string): store.WriteContext {
  return { db: env.DB, now, requestId };
}

const PROBLEMS = {
  INVALID_LINE: ImportProblem_Reason.INVALID_LINE,
  INVALID_KEY: ImportProblem_Reason.INVALID_KEY,
  RESERVED_KEY: ImportProblem_Reason.RESERVED_KEY,
  INVALID_VALUE: ImportProblem_Reason.INVALID_VALUE,
  DUPLICATE_KEY: ImportProblem_Reason.DUPLICATE_KEY,
  LINK_EXISTS: ImportProblem_Reason.LINK_EXISTS,
  LINK_DELETED: ImportProblem_Reason.LINK_DELETED,
  LINKS_FULL: ImportProblem_Reason.LINKS_FULL,
} as const satisfies Record<Exclude<keyof typeof ImportProblem_Reason, 'UNSPECIFIED'>, ImportProblem_Reason>;
type ProblemName = keyof typeof PROBLEMS;

/** One import line as a valid item, or the problem that skips it. */
function importLine(line: string, number: number, host: string): store.ImportItem | ProblemName {
  let link: Link;
  try {
    link = fromWire(LinkSchema, JSON.parse(line), { strict: true }).message;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof WireJsonError) return 'INVALID_LINE';
    throw error;
  }
  if (link.name === '') return 'INVALID_LINE';
  const id = link.name.startsWith('links/') ? link.name.slice('links/'.length) : '/';
  const normalized = normalizeKey(id);
  if (!('key' in normalized)) return normalized.problem;
  const content = contentOf(link, '*', null, host);
  return typeof content === 'string' ? 'INVALID_VALUE' : { line: number, key: normalized.key, content };
}

// ---- the handlers ---------------------------------------------------------------------------------------------------

export const handlers: ServiceHandlers<ShapeOf<typeof LinksUiService>, ApiContext> = {
  async getLink(request, { env, now }) {
    const key = keyOf(request.name);
    const row = await dependency(() => store.getLink(env.DB, key, now));
    if (row === null) throw linksError('NOT_FOUND');
    return linkMessage(row);
  },

  async listLinks(request, { env, now }) {
    const size = pageSize(request.pageSize, LIST_PAGE);
    const literals = filterLiterals(request.filter);
    // AIP-158: a token continues only the list it was made for (page_size may change between pages).
    const parameters = { filter: request.filter, show_deleted: request.showDeleted };
    const after = cursorOf(request.pageToken, parameters, (cursor) => (typeof cursor === 'string' && KEY_PATTERN.test(cursor) ? cursor : null));
    const page = await dependency(() => store.listLinks(env.DB, { after, literals, showDeleted: request.showDeleted, size }, now));
    const last = page.rows[page.rows.length - 1];
    const next = page.more && last !== undefined ? encodePageToken(last.key, parameters) : '';
    return create(ListLinksResponseSchema, { links: page.rows.map((row) => linkMessage(row)), nextPageToken: next });
  },

  /** AIP-133: the answer's name is links/<link_id in lower case>. */
  async createLink(request, { env, now }) {
    const normalized = normalizeKey(request.linkId);
    if (!('key' in normalized)) throw linksError(normalized.problem);
    const content = contentOrThrow(contentOf(request.link ?? bad(), '*', null, hostOf(env)));
    const outcome = await dependency(() => store.createLink(writeContext(env, now, request.requestId), normalized.key, content, respondLink));
    return settle(LinkSchema, outcome, (row) => linkMessage(row));
  },

  /** AIP-134 with AIP-154: the masked fields (or all), only if the link still has the etag the client sent. */
  async updateLink(request, { env, now }) {
    const link = request.link ?? bad();
    const key = keyOf(link.name);
    const paths = updatePaths(request.updateMask);
    const host = hostOf(env);
    const merge = (row: LinkRow) => contentOrThrow(contentOf(link, paths, row, host));
    const outcome = await dependency(() => store.updateLink(writeContext(env, now, request.requestId), key, link.etag, merge, respondLink));
    return settle(LinkSchema, outcome, (row) => linkMessage(row));
  },

  /** AIP-164: a soft delete that answers the deleted link; NOT_FOUND (with the link) when it is deleted already. */
  async deleteLink(request, { env, now }) {
    const key = keyOf(request.name);
    const outcome = await dependency(() => store.deleteLink(writeContext(env, now, request.requestId), key, request.etag, respondLink));
    return settle(LinkSchema, outcome, (row) => linkMessage(row));
  },

  /** AIP-164: NOT_DELETED, ALREADY_EXISTS (409), when the link is not deleted. */
  async undeleteLink(request, { env, now }) {
    const key = keyOf(request.name);
    const outcome = await dependency(() => store.undeleteLink(writeContext(env, now, request.requestId), key, request.etag, respondLink));
    return settle(LinkSchema, outcome, (row) => linkMessage(row));
  },

  async listLinkRevisions(request, { env, now }) {
    const key = keyOf(request.name);
    const size = pageSize(request.pageSize, REVISIONS_KEPT);
    const before = cursorOf(request.pageToken, { name: key }, (cursor) => (typeof cursor === 'number' && Number.isInteger(cursor) && cursor > 0 ? cursor : null));
    const page = await dependency(() => store.listRevisions(env.DB, key, before, size, now));
    if (page.row === null) throw linksError('NOT_FOUND');
    const row = page.row;
    const last = page.revisions[page.revisions.length - 1];
    const next = page.more && last !== undefined ? encodePageToken(last.revision, { name: key }) : '';
    return create(ListLinkRevisionsResponseSchema, { links: page.revisions.map((revision) => linkMessage(row, revision)), nextPageToken: next });
  },

  async rollbackLink(request, { env, now }) {
    const key = keyOf(request.name);
    if (!/^[1-9][0-9]{0,8}$/.test(request.revisionId)) throw linksError('REVISION_NOT_FOUND');
    const revision = Number(request.revisionId);
    const outcome = await dependency(() => store.rollbackLink(writeContext(env, now, request.requestId), key, revision, respondLink));
    return settle(LinkSchema, outcome, (row) => linkMessage(row));
  },

  /** Every valid line is imported in one batch; every other line is reported with its reason. */
  async importLinks(request, { env, now }) {
    if (request.content.length > IMPORT_CHARS_MAX) bad();
    const lines = request.content.split('\n').map((line, index) => ({ text: line.replace(/\r$/, ''), number: index + 1 }));
    const filled = lines.filter((line) => line.text.trim() !== '');
    if (filled.length > IMPORT_LINES_MAX) bad();
    const host = hostOf(env);
    const items: store.ImportItem[] = [];
    const problems: { line: number; reason: ProblemName }[] = [];
    const seen = new Set<string>();
    for (const { text, number } of filled) {
      const item = importLine(text, number, host);
      if (typeof item === 'string') problems.push({ line: number, reason: item });
      else if (seen.has(item.key)) problems.push({ line: number, reason: 'DUPLICATE_KEY' });
      else {
        seen.add(item.key);
        items.push(item);
      }
    }
    const answer = (result: store.ImportResult): ImportLinksResponse => {
      const all = [...problems, ...result.problems].sort((a, b) => a.line - b.line);
      return create(ImportLinksResponseSchema, {
        createdCount: result.created,
        replacedCount: result.replaced,
        skippedCount: all.length,
        problems: all.map((problem) => ({ lineNumber: problem.line, reason: PROBLEMS[problem.reason] })),
      });
    };
    const outcome = await dependency(() =>
      store.importLinks(writeContext(env, now, request.requestId), items, request.overwrite, (result) => wireOf(ImportLinksResponseSchema, answer(result))),
    );
    return settle(ImportLinksResponseSchema, outcome, answer);
  },

  /** JSON Lines of a page of live links, written directly from the rows (model.ts linkWire equals toWire of each). */
  async exportLinks(request, { env }) {
    const size = pageSize(request.pageSize, EXPORT_PAGE);
    const after = cursorOf(request.pageToken, {}, (cursor) => (typeof cursor === 'string' && KEY_PATTERN.test(cursor) ? cursor : null));
    const page = await dependency(() => store.exportLinks(env.DB, after, size));
    const last = page.rows[page.rows.length - 1];
    return create(ExportLinksResponseSchema, {
      lines: page.rows.map((row) => JSON.stringify(linkWire(row))),
      nextPageToken: page.more && last !== undefined ? encodePageToken(last.key, {}) : '',
    });
  },
};
