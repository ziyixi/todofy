/**
 * An independent copy of mailsort's closed table of Google operations (../../src/gmail.ts), written from the design
 * (../../../docs/design.md §2) rather than from the code, as the oracle of the guard tests: every request the fakes
 * receive must be one of these. It knows the owned labels and the ledger only through what the test passes in.
 */

export interface TableContext {
  /** Gmail IDs of mailsort's labels: the ones it created or adopted. */
  readonly owned: ReadonlySet<string>;
  /**
   * Exact single-level English names planned by the store. Creating grouping parents is forbidden.
   */
  readonly planned: ReadonlySet<string>;
  /** The ledger row's state and archive flag for (message, Gmail label), or null. */
  readonly ledger: (messageId: string, labelId: string) => { state: string; archived: boolean } | null;
  /** Independent test fixture's explicit migration scope, never inferred from a request. */
  readonly merge?: { readonly labels: ReadonlySet<string>; readonly messages: ReadonlySet<string>; readonly swaps: ReadonlySet<string>; readonly hidden: ReadonlySet<string>; readonly names: ReadonlySet<string>; readonly createNames?: ReadonlySet<string> };

}

const MESSAGE_ID = /^[0-9a-f]{6,32}$/;

/** Independent single-level English name check. */
function okName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 40 && name.trim() === name && /[A-Za-z]/.test(name) && /^[A-Za-z0-9 &'().,+_-]+$/.test(name);
}

function okCreateName(name: unknown, planned: ReadonlySet<string>): boolean {
  return okName(name) && planned.has(name);
}

/** labels.patch: a planned path (the guard narrows it to the one planned for that label). */
function okPatchName(name: unknown, planned: ReadonlySet<string>): boolean {
  return okName(name) && planned.has(name);
}

/** A JSON object body exactly as JSON.stringify writes its parsed value (no duplicate keys, no other spelling), or null. */
function canonicalObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === 'object' && value !== null && !Array.isArray(value) && JSON.stringify(value) === body ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The operation name, or null when the request is not in the table. */
export function allowedOperation(method: string, rawUrl: string, body: string, ctx: TableContext): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const params = [...url.searchParams.keys()];
  const only = (...names: string[]) => params.every((name) => names.includes(name));
  if (url.host === 'oauth2.googleapis.com') {
    const form = new URLSearchParams(body);
    return method === 'POST' && url.pathname === '/token' && form.get('grant_type') === 'refresh_token' && [...form.keys()].length === 4 ? 'token' : null;
  }
  if (url.host !== 'gmail.googleapis.com' || !url.pathname.startsWith('/gmail/v1/users/me/')) return null;
  const path = url.pathname.slice('/gmail/v1/users/me/'.length).split('/');
  if (method === 'GET' && path.join('/') === 'profile') return url.searchParams.get('fields') === 'historyId' && only('fields') ? 'profile' : null;
  if (method === 'GET' && path.join('/') === 'history') {
    const types = url.searchParams.getAll('historyTypes');
    const label = url.searchParams.get('labelId');
    return only('startHistoryId', 'historyTypes', 'maxResults', 'pageToken', 'labelId') &&
      types.length > 0 &&
      types.every((type) => ['messageAdded', 'labelAdded', 'labelRemoved'].includes(type)) &&
      (label === null || label === 'INBOX')
      ? 'history'
      : null;
  }
  if (method === 'GET' && path.join('/') === 'messages') {
    if (url.searchParams.get('fields') === 'messages/id,nextPageToken,resultSizeEstimate') return only('labelIds', 'fields', 'maxResults', 'includeSpamTrash') && ctx.merge?.labels.has(url.searchParams.get('labelIds') ?? '') === true && url.searchParams.get('includeSpamTrash') === 'true' && Number(url.searchParams.get('maxResults')) <= 10 ? 'merge_list' : null;
    return only('labelIds', 'q', 'maxResults', 'pageToken') && url.searchParams.get('labelIds') === 'INBOX' && url.searchParams.get('q') === 'newer_than:2d' ? 'messages_list' : null;
  }
  if (method === 'GET' && path[0] === 'messages' && path.length === 2) {
    if (url.searchParams.get('format') === 'minimal') return only('format', 'fields') && url.searchParams.get('fields') === 'id,labelIds,historyId' && ctx.merge?.messages.has(path[1] ?? '') === true ? 'merge_metadata' : null;
    return MESSAGE_ID.test(path[1] ?? '') && only('format', 'metadataHeaders', 'fields') && ['full', 'metadata'].includes(url.searchParams.get('format') ?? '') ? 'message_get' : null;
  }
  if (method === 'GET' && path.join('/') === 'labels') return params.length === 0 ? 'labels_list' : null;
  if (method === 'POST' && path.join('/') === 'labels') {
    const value = canonicalObject(body);
    if (value === null) return null;
    const planned = okCreateName(value['name'], ctx.planned) || (okName(value['name']) && ctx.merge?.createNames?.has(value['name']) === true);
    return planned && value['labelListVisibility'] === 'labelShow' && value['messageListVisibility'] === 'show' && Object.keys(value).every((key) => ['name', 'labelListVisibility', 'messageListVisibility'].includes(key)) ? 'labels_create' : null;
  }
  if (method === 'PATCH' && path[0] === 'labels' && path.length === 2) {
    const value = canonicalObject(body);
    if (value === null) return null;
    if (Object.keys(value).length === 2 && value['labelListVisibility'] === 'labelHide' && value['messageListVisibility'] === 'hide') return ctx.merge?.hidden.has(path[1] ?? '') === true ? 'labels_hide' : null;
    return ctx.owned.has(path[1] ?? '') && (okPatchName(value['name'], ctx.planned) || (typeof value['name'] === 'string' && ctx.merge?.names.has(value['name']) === true)) && Object.keys(value).join() === 'name' ? 'labels_patch' : null;
  }
  if (method === 'POST' && path[0] === 'messages' && path[2] === 'modify' && path.length === 3) {
    const id = path[1] ?? '';
    if (!MESSAGE_ID.test(id)) return null;
    const value = canonicalObject(body) as { addLabelIds?: string[]; removeLabelIds?: string[] } | null;
    if (value === null) return null;
    const add = value.addLabelIds ?? [];
    const remove = value.removeLabelIds ?? [];
    if (Object.keys(value).some((key) => key !== 'addLabelIds' && key !== 'removeLabelIds')) return null;
    const inbox = (list: string[]) => list.length === 0 || (list.length === 1 && list[0] === 'INBOX');
    if (add.length === 1 && remove.length === 1 && add[0] !== remove[0] && ctx.owned.has(add[0] ?? '') && ctx.owned.has(remove[0] ?? '')) return ctx.merge?.swaps.has(`${id}:${remove[0] ?? ''}:${add[0] ?? ''}`) === true ? 'merge_modify' : null;
    if (add.length === 1 && inbox(remove) && ctx.owned.has(add[0] ?? '')) {
      const row = ctx.ledger(id, add[0] ?? '');
      return row !== null && ['intended', 'applied'].includes(row.state) && row.archived === (remove.length === 1) ? 'classify' : null;
    }
    if (remove.length === 1 && inbox(add) && ctx.owned.has(remove[0] ?? '')) {
      const row = ctx.ledger(id, remove[0] ?? '');
      return row !== null && row.state === 'undo_intended' && row.archived === (add.length === 1) ? 'undo' : null;
    }
    return null;
  }
  return null;
}

/** Labels Gmail owns or that carry meaning beyond mailsort's: never in any modify mailsort sends. */
export const FORBIDDEN_LABELS = ['UNREAD', 'STARRED', 'IMPORTANT', 'SPAM', 'TRASH', 'SENT', 'DRAFT', 'CHAT', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'CATEGORY_PERSONAL'];
