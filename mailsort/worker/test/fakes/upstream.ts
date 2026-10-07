/**
 * The one fake behind every outbound request of the Worker in the workerd tests and the local smoke run: Google (the
 * fake Gmail and token endpoint) and Workers AI (`POST /ai/run/<model>`, the shape of env.ts aiRunner's development
 * runner). The Worker's development fetch (env.ts upstreamFetch) sends each Google request to this loopback origin with
 * the real Google URL in `x-mailsort-original-url`; anything else is a 502 and is recorded as a stray request.
 */
import { FakeAi } from './fake-ai.ts';
import { FakeGmail } from './fake-gmail.ts';

export const ORIGINAL_URL_HEADER = 'x-mailsort-original-url';

export class FakeUpstream {
  readonly gmail = new FakeGmail();
  readonly ai = new FakeAi();
  /** Requests that were neither Google nor Workers AI. */
  readonly strays: string[] = [];
  /**
   * Reads the store's label paths (the workerd harness and the smoke run set it). Called when a label create or rename
   * arrives, while the Worker waits for it: the independent table then checks the name against what the store
   * planned at that moment, not only its shape (../runtime/helpers.ts checkGoogleCalls).
   */
  plannedPaths: (() => Promise<readonly string[]>) | null = null;

  reset(): void {
    this.gmail.reset();
    this.ai.reset();
    this.strays.length = 0;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    if (request.method === 'POST' && url.pathname.startsWith('/ai/run/')) {
      try {
        return Response.json(this.ai.run(decodeURIComponent(url.pathname.slice('/ai/run/'.length)), JSON.parse(body) as Record<string, unknown>));
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'ai_error' }, { status: 500 });
      }
    }
    // The development fetch sends the real URL in a header; without the bypass (the CPU test) the URL is Google's itself.
    const original = request.headers.get(ORIGINAL_URL_HEADER) ?? (/^https:\/\/(gmail|oauth2)\.googleapis\.com\//.test(request.url) ? request.url : null);
    if (original === null) {
      this.strays.push(`${request.method} ${request.url}`);
      return new Response('stray', { status: 502 });
    }
    const google = new URL(original);
    const labelWrite = (request.method === 'POST' || request.method === 'PATCH') && /\/labels(\/[^/]+)?$/.test(google.pathname);
    const planned = labelWrite ? await this.plannedPaths?.() : undefined;
    return this.gmail.handle(request.method, google, request.headers, body, planned);
  }
}
