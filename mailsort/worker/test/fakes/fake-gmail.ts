/**
 * A fake Gmail and Google token endpoint for the tests and the local smoke run (../../../docs/design.md §11): an
 * in-memory mailbox with messages, labels and a history log, answering the requests mailsort's closed table allows the
 * way Gmail's REST API does (the fields mailsort reads). It records every request it receives, so a test can check each
 * one against an independent copy of the table (./table.ts). All data is synthetic (fixtures.ts).
 */

export interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: Set<string>;
  snippet: string;
  internalDate: number;
  payload: unknown;
}

export interface HistoryEntry {
  id: number;
  messagesAdded?: { message: { id: string; threadId: string; labelIds: string[] } }[];
  labelsAdded?: { message: { id: string; labelIds: string[] }; labelIds: string[] }[];
  labelsRemoved?: { message: { id: string; labelIds: string[] }; labelIds: string[] }[];
}

export interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body: string;
  /** For a label create or rename: the paths the store held when it was sent (FakeUpstream.plannedPaths). */
  readonly planned?: readonly string[];
}

const SYSTEM_LABELS = ['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'CHAT', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'CATEGORY_PERSONAL'];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const gmailError = (status: number, reason: string) => json({ error: { code: status, message: reason, errors: [{ reason }], status: reason } }, status);

export class FakeGmail {
  readonly messages = new Map<string, FakeMessage>();
  readonly labels = new Map<string, { id: string; name: string; type: 'system' | 'user' }>();
  /** User labels the Worker created (labels.create). */
  readonly createdByWorker = new Set<string>();
  /** User labels the test's owner made with the name of a label of mailsort's, for mailsort to adopt. */
  readonly adoptable = new Set<string>();
  readonly history: HistoryEntry[] = [];
  readonly calls: RecordedCall[] = [];
  historyId = 1000;
  /** History records older than this ID are gone (a 404 for a start before it). */
  oldestHistoryId = 0;
  nextLabel = 1;
  /** The fake's clock (the resync's two days); the tests set it to their own. */
  clock: () => number = () => Date.now();
  /** The refresh tokens Google accepts, and the scope each grant has. */
  readonly grants = new Map<string, string>();
  /** Answer every Gmail call with this status (429, 500) while set. */
  failWith: number | null = null;
  /** Answer the Gmail calls it picks with the status it gives (a failing modify, one unreadable message). */
  failWhen: ((method: string, url: URL) => number | null) | null = null;
  /** Called after each answered request (a mail that arrives between two reads). */
  afterCall: ((method: string, url: URL) => void) | null = null;
  private accessTokens = new Map<string, string>();
  private nextToken = 1;

  constructor() {
    for (const id of SYSTEM_LABELS) this.labels.set(id, { id, name: id, type: 'system' });
  }

  reset(): void {
    this.messages.clear();
    for (const [id, label] of this.labels) if (label.type === 'user') this.labels.delete(id);
    this.createdByWorker.clear();
    this.adoptable.clear();
    this.history.length = 0;
    this.calls.length = 0;
    this.historyId = 1000;
    this.oldestHistoryId = 0;
    this.failWith = null;
    this.failWhen = null;
    this.afterCall = null;
    this.accessTokens.clear();
  }

  private record(entry: Omit<HistoryEntry, 'id'>): void {
    this.historyId += 1;
    this.history.push({ id: this.historyId, ...entry });
  }

  /** A mail arrives (INBOX unless `labels` says otherwise), with a messageAdded history record. */
  deliver(message: Omit<FakeMessage, 'labelIds'> & { labelIds: string[] }): void {
    const stored: FakeMessage = { ...message, labelIds: new Set(message.labelIds) };
    this.messages.set(message.id, stored);
    this.record({ messagesAdded: [{ message: { id: message.id, threadId: message.threadId, labelIds: [...stored.labelIds] } }] });
  }

  /** The owner changes labels by hand (in Gmail's own UI): history records, as Gmail writes them. */
  ownerModify(messageId: string, add: string[], remove: string[]): void {
    this.applyModify(messageId, add, remove);
  }

  labelIdByName(name: string): string | undefined {
    return [...this.labels.values()].find((label) => label.name === name)?.id;
  }

  /**
   * The owner makes a label by hand. `adoptable`: it has the name of one of mailsort's labels, which the owner's sync
   * adopts and mailsort may write from then on; any other label of the owner's is never written (the independent
   * table's check).
   */
  createUserLabel(name: string, adoptable = false): string {
    const id = `Label_${String(this.nextLabel++)}`;
    this.labels.set(id, { id, name, type: 'user' });
    if (adoptable) this.adoptable.add(id);
    return id;
  }

  /**
   * The labels mailsort may write: the ones it created and the ones the test made for it to adopt, leaves only. One
   * with labels nested under it (a parent mailsort made, or the owner's) only groups, and no mail may get it.
   */
  mailsortLabelIds(): Set<string> {
    const names = [...this.labels.values()].filter((label) => label.type === 'user').map((label) => label.name);
    const isParent = (id: string) => {
      const name = this.labels.get(id)?.name;
      return name !== undefined && names.some((other) => other.startsWith(`${name}/`));
    };
    return new Set([...this.createdByWorker, ...this.adoptable].filter((id) => !isParent(id)));
  }

  private applyModify(messageId: string, add: string[], remove: string[]): boolean {
    const message = this.messages.get(messageId);
    if (message === undefined) return false;
    const added = add.filter((label) => !message.labelIds.has(label));
    const removed = remove.filter((label) => message.labelIds.has(label));
    for (const label of added) message.labelIds.add(label);
    for (const label of removed) message.labelIds.delete(label);
    const labels = [...message.labelIds];
    if (added.length > 0) this.record({ labelsAdded: [{ message: { id: messageId, labelIds: labels }, labelIds: added }] });
    if (removed.length > 0) this.record({ labelsRemoved: [{ message: { id: messageId, labelIds: labels }, labelIds: removed }] });
    return true;
  }

  /** Every request Google would get. `url` is the real Google URL; `planned` is recorded with it (RecordedCall). */
  handle(method: string, url: URL, headers: Headers, body: string, planned?: readonly string[]): Response {
    const response = this.answer(method, url, headers, body, planned);
    this.afterCall?.(method, url);
    return response;
  }

  private answer(method: string, url: URL, headers: Headers, body: string, planned: readonly string[] | undefined): Response {
    this.calls.push({ method, url: url.toString(), body, ...(planned === undefined ? {} : { planned }) });
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token' && method === 'POST') {
      const form = new URLSearchParams(body);
      const scope = this.grants.get(form.get('refresh_token') ?? '');
      if (form.get('grant_type') !== 'refresh_token' || scope === undefined) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
      const token = `ya29.synthetic-${String(this.nextToken++)}`;
      this.accessTokens.set(token, scope);
      return json({ access_token: token, expires_in: 3599, scope, token_type: 'Bearer' });
    }
    if (url.host !== 'gmail.googleapis.com') return new Response('unknown host', { status: 502 });
    const auth = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1];
    const scope = auth === undefined ? undefined : this.accessTokens.get(auth);
    if (scope === undefined) return gmailError(401, 'authError');
    if (this.failWith !== null) return gmailError(this.failWith, this.failWith === 429 ? 'rateLimitExceeded' : 'backendError');
    const injected = this.failWhen?.(method, url) ?? null;
    if (injected !== null) return gmailError(injected, injected === 429 ? 'rateLimitExceeded' : injected >= 500 ? 'backendError' : 'failedPrecondition');
    const writable = scope.split(' ').includes('https://www.googleapis.com/auth/gmail.modify');
    const path = url.pathname.replace(/^\/gmail\/v1\/users\/me\//, '');
    const parts = path.split('/');

    if (method === 'GET' && path === 'profile') return json({ historyId: String(this.historyId) });
    if (method === 'GET' && path === 'history') {
      const start = Number(url.searchParams.get('startHistoryId'));
      if (start < this.oldestHistoryId) return gmailError(404, 'notFound');
      const max = Number(url.searchParams.get('maxResults') ?? '100');
      const offset = Number(url.searchParams.get('pageToken') ?? '0');
      const after = this.history.filter((entry) => entry.id > start);
      const page = after.slice(offset, offset + max);
      const more = offset + max < after.length;
      return json({
        ...(page.length > 0 ? { history: page.map((entry) => ({ ...entry, id: String(entry.id) })) } : {}),
        historyId: String(this.historyId),
        ...(more ? { nextPageToken: String(offset + max) } : {}),
      });
    }
    if (method === 'GET' && path === 'messages') {
      const since = this.clock() - 2 * 86_400_000;
      const ids = [...this.messages.values()].filter((m) => m.labelIds.has('INBOX') && m.internalDate >= since).map((m) => ({ id: m.id, threadId: m.threadId }));
      return json({ messages: ids.slice(0, Number(url.searchParams.get('maxResults') ?? '100')), resultSizeEstimate: ids.length });
    }
    if (method === 'GET' && parts[0] === 'messages' && parts.length === 2) {
      const message = this.messages.get(parts[1] ?? '');
      if (message === undefined) return gmailError(404, 'notFound');
      const format = url.searchParams.get('format');
      const payload = format === 'metadata' ? { mimeType: (message.payload as { mimeType?: string }).mimeType, headers: (message.payload as { headers?: unknown }).headers } : message.payload;
      return json({ id: message.id, threadId: message.threadId, labelIds: [...message.labelIds], snippet: message.snippet, internalDate: String(message.internalDate), payload });
    }
    if (method === 'GET' && path === 'labels') return json({ labels: [...this.labels.values()] });
    if (method === 'POST' && path === 'labels') {
      if (!writable) return gmailError(403, 'insufficientPermissions');
      const { name } = JSON.parse(body) as { name: string };
      if ([...this.labels.values()].some((label) => label.name === name)) return gmailError(409, 'duplicate');
      const id = this.createUserLabel(name);
      this.createdByWorker.add(id);
      return json({ id, name, type: 'user' });
    }
    if (method === 'PATCH' && parts[0] === 'labels' && parts.length === 2) {
      if (!writable) return gmailError(403, 'insufficientPermissions');
      const label = this.labels.get(parts[1] ?? '');
      if (label === undefined || label.type !== 'user') return gmailError(404, 'notFound');
      const { name } = JSON.parse(body) as { name: string };
      if ([...this.labels.values()].some((other) => other.id !== label.id && other.name === name)) return gmailError(409, 'duplicate');
      label.name = name;
      return json(label);
    }
    if (method === 'POST' && parts[0] === 'messages' && parts[2] === 'modify') {
      if (!writable) return gmailError(403, 'insufficientPermissions');
      const { addLabelIds = [], removeLabelIds = [] } = JSON.parse(body) as { addLabelIds?: string[]; removeLabelIds?: string[] };
      if (!this.applyModify(parts[1] ?? '', addLabelIds, removeLabelIds)) return gmailError(404, 'notFound');
      const message = this.messages.get(parts[1] ?? '');
      return json({ id: parts[1], labelIds: [...(message?.labelIds ?? [])] });
    }
    return gmailError(400, 'unsupported');
  }
}
