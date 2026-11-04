import { DurableObject } from 'cloudflare:workers';
import { HttpTranscoder } from '@ziyixi/proto/http-transcoder';
import { Code } from '@ziyixi/proto/rpc-status';
import { StorageUiService } from '@ziyixi/proto/storage/ui/v1/storage_ui_service_pb';
import { WireJsonError } from '@ziyixi/proto/wire-json';
import { batchCreate } from './batch.ts';
import { Dropbox } from './dropbox.ts';
import { DOMAIN, MACHINE_AUTHORIZATION, type Env } from './env.ts';
import { badRequest, errorResponse, failure } from './errors.ts';
import { digest, hex } from './keys.ts';
import { list, readContent, stat, writeContent } from './objects.ts';
import { handlers, type OwnerContext } from './owner.ts';
import { Store, type ClientRow } from './store.ts';
import { FLUSH_DELAY_MS, Usage, type Amounts, type Operation } from './usage.ts';

const ownerApi = new HttpTranscoder<typeof StorageUiService.method, OwnerContext>(StorageUiService, handlers, {
  domain: DOMAIN, maxBodyBytes: 16 * 1024,
  // Only the outer Worker's Access/CSRF gates can forward an owner request here.
  authorize: () => undefined,
});

const CONTENT_OPERATIONS: Readonly<Record<string, Operation>> = { GET: 'get', HEAD: 'head', PUT: 'put', POST: 'batch_create' };

/** The counted operation of an application request; unknown paths and methods fail before counting. */
function operationOf(request: Request, path: string): Operation {
  if (path === '/api/storage/v1/content') {
    const operation = CONTENT_OPERATIONS[request.method];
    if (operation === undefined) throw failure(Code.UNIMPLEMENTED, 'METHOD_NOT_ALLOWED', 405);
    return operation;
  }
  if (path !== '/api/storage/v1/stat' && path !== '/api/storage/v1/list') throw failure(Code.NOT_FOUND, 'NOT_FOUND');
  if (request.method !== 'POST') throw failure(Code.UNIMPLEMENTED, 'METHOD_NOT_ALLOWED', 405);
  return path === '/api/storage/v1/stat' ? 'stat' : 'list';
}

function contentLength(headers: Headers): number {
  const value = Number(headers.get('content-length') ?? 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export class StorageState extends DurableObject<Env> {
  private readonly store: Store;
  private readonly dropbox: Dropbox;
  private readonly usage = new Usage();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorSecret = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    this.dropbox = new Dropbox(this.store, env);
    void ctx.blockConcurrencyWhile(() => {
      const existing = this.store.get('cursor_key') as string | null;
      this.cursorSecret = existing ?? hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
      if (existing === null) this.store.set('cursor_key', this.cursorSecret);
      return Promise.resolve();
    });
  }

  private async machine(request: Request): Promise<Response> {
    const authorization = request.headers.get('authorization') ?? '';
    if (!MACHINE_AUTHORIZATION.test(authorization)) throw failure(Code.UNAUTHENTICATED, 'UNAUTHORIZED');
    const client = this.store.authenticate(await digest(authorization.slice('Bearer '.length)));
    if (client === null) throw failure(Code.UNAUTHENTICATED, 'UNAUTHORIZED');
    const operation = operationOf(request, new URL(request.url).pathname);
    try {
      const { response, amounts } = await this.perform(operation, request, client);
      this.usage.succeeded(client.id, operation, amounts);
      return response;
    } catch (caught) {
      // Record the answer the caller receives: a malformed JSON body is its 400, not an internal error.
      const error = caught instanceof WireJsonError ? failure(Code.INVALID_ARGUMENT, 'BAD_REQUEST') : caught;
      this.usage.failed(client.id, operation, error);
      throw error;
    } finally {
      this.scheduleFlush();
    }
  }

  private async perform(operation: Operation, request: Request, client: ClientRow): Promise<{ readonly response: Response; readonly amounts?: Amounts }> {
    switch (operation) {
      case 'get': {
        const response = await readContent(request, client, this.dropbox);
        return { response, amounts: { downloadBytes: contentLength(response.headers) } };
      }
      case 'head': return { response: await readContent(request, client, this.dropbox) };
      // A successful write consumed exactly its declared Content-Length.
      case 'put': return { response: await writeContent(request, client, this.dropbox), amounts: { objects: 1, uploadBytes: contentLength(request.headers) } };
      case 'batch_create': {
        const result = await batchCreate(request, client, this.dropbox);
        return { response: result.response, amounts: { objects: result.objectCount, uploadBytes: contentLength(request.headers) } };
      }
      case 'stat':
      case 'list':
        if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '')) badRequest();
        return { response: operation === 'stat' ? await stat(request, client, this.dropbox) : await list(request, client, this.dropbox, this.cursorSecret) };
    }
  }

  /**
   * Counters reach SQLite about 30 seconds after the first request that changed them, not on every request. The
   * pending timer keeps this object in memory until then; an alarm would wake a fresh instance without the counts
   * once an idle object hibernates, about 10 seconds after its last request.
   */
  private scheduleFlush(): void {
    if (this.flushTimer !== null || !this.usage.dirty) return;
    const local = this.env.DEV_AUTH_BYPASS === 'true' && /^[0-9]{1,5}$/.test(this.env.DEV_USAGE_FLUSH_MS ?? '');
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try { this.flushUsage(); } catch {
        // The counts stay in memory for the next flush; only the event name is logged.
        console.error(JSON.stringify({ event: 'storage_usage_flush_failed' }));
      }
    }, local ? Number(this.env.DEV_USAGE_FLUSH_MS) : FLUSH_DELAY_MS);
  }

  private flushUsage(): void {
    this.usage.flush(this.store, (write) => { this.ctx.storage.transactionSync(write); });
    this.dropbox.flushRepeatedFailure();
  }

  override async fetch(request: Request): Promise<Response> {
    const id = crypto.randomUUID();
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/storage/v1/')) return await this.machine(request);
      if (url.pathname === '/api/dropbox/callback' && request.method === 'GET') {
        await this.dropbox.callback(url.searchParams);
        return new Response(null, { status: 303, headers: { location: '/' } });
      }
      const result = await ownerApi.handle(request, {
        store: this.store, dropbox: this.dropbox, redirectUri: url.origin + '/api/dropbox/callback',
        flushUsage: () => { this.flushUsage(); }, buildSha: this.env.BUILD_SHA ?? 'dev',
        stateSizeBytes: () => this.ctx.storage.sql.databaseSize,
      }, id);
      return result?.response ?? errorResponse(failure(Code.NOT_FOUND, 'NOT_FOUND'), id, request.method === 'HEAD');
    } catch (error) {
      return errorResponse(error instanceof WireJsonError ? failure(Code.INVALID_ARGUMENT, 'BAD_REQUEST') : error, id, request.method === 'HEAD');
    }
  }
}
