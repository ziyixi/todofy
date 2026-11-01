import { DurableObject } from 'cloudflare:workers';
import { HttpTranscoder } from '@ziyixi/proto/http-transcoder';
import { Code } from '@ziyixi/proto/rpc-status';
import { StorageUiService } from '@ziyixi/proto/storage/ui/v1/storage_ui_service_pb';
import { WireJsonError } from '@ziyixi/proto/wire-json';
import { Dropbox } from './dropbox.ts';
import { DOMAIN, type Env } from './env.ts';
import { badRequest, errorResponse, failure } from './errors.ts';
import { digest, hex } from './keys.ts';
import { list, readContent, stat, writeContent } from './objects.ts';
import { handlers, type OwnerContext } from './owner.ts';
import { Store } from './store.ts';

const ownerApi = new HttpTranscoder<typeof StorageUiService.method, OwnerContext>(StorageUiService, handlers, {
  domain: DOMAIN, maxBodyBytes: 16 * 1024,
  // Only the outer Worker's Access/CSRF gates can forward an owner request here.
  authorize: () => undefined,
});

export class StorageState extends DurableObject<Env> {
  private readonly store: Store;
  private readonly dropbox: Dropbox;
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
    if (!/^Bearer sto_[A-Za-z0-9_-]{43}$/.test(authorization)) throw failure(Code.UNAUTHENTICATED, 'UNAUTHORIZED');
    const client = this.store.authenticate(await digest(authorization.slice('Bearer '.length)));
    if (client === null) throw failure(Code.UNAUTHENTICATED, 'UNAUTHORIZED');
    const path = new URL(request.url).pathname;
    if (path === '/api/storage/v1/content') {
      if (request.method === 'GET' || request.method === 'HEAD') return readContent(request, client, this.dropbox);
      if (request.method === 'PUT') return writeContent(request, client, this.dropbox);
      throw failure(Code.UNIMPLEMENTED, 'METHOD_NOT_ALLOWED', 405);
    }
    if (path !== '/api/storage/v1/stat' && path !== '/api/storage/v1/list') throw failure(Code.NOT_FOUND, 'NOT_FOUND');
    if (request.method !== 'POST') throw failure(Code.UNIMPLEMENTED, 'METHOD_NOT_ALLOWED', 405);
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '')) badRequest();
    return path === '/api/storage/v1/stat' ? stat(request, client, this.dropbox) : list(request, client, this.dropbox, this.cursorSecret);
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
      }, id);
      return result?.response ?? errorResponse(failure(Code.NOT_FOUND, 'NOT_FOUND'), id, request.method === 'HEAD');
    } catch (error) {
      return errorResponse(error instanceof WireJsonError ? failure(Code.INVALID_ARGUMENT, 'BAD_REQUEST') : error, id, request.method === 'HEAD');
    }
  }
}
