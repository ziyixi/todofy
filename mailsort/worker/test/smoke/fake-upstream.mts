/**
 * The fake Gmail and fake Workers AI (../fakes/upstream.ts) on a loopback HTTP port, for the smoke run (./smoke.mts)
 * and for trying the UI by hand with `wrangler dev` (../../../.dev.vars.example sets DEV_FAKE_UPSTREAM to it). It
 * accepts the synthetic grant of .dev.vars.example (gmail.modify) and, for manual tries, delivers a synthetic mail of
 * ../fakes/fixtures.ts on `POST /__fake/deliver?mail=<name>`. Nothing here reaches Google or Cloudflare.
 *
 *   node test/smoke/fake-upstream.mts 8796
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { MAILS, message } from '../fakes/fixtures.ts';
import { FakeUpstream } from '../fakes/upstream.ts';

export const DEV_REFRESH_TOKEN = 'synthetic-refresh-token';

async function body(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk as Uint8Array);
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Serves `up` on 127.0.0.1:`port` (0: any free port); answers the server and its origin. */
export async function serveFakeUpstream(up: FakeUpstream, port = 0): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    void (async () => {
      const raw = await body(request);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'POST' && url.pathname === '/__fake/deliver') {
        const name = url.searchParams.get('mail') ?? '';
        const mail = (MAILS as Record<string, (typeof MAILS)[keyof typeof MAILS] | undefined>)[name];
        if (mail === undefined) {
          response.writeHead(404).end('unknown synthetic mail\n');
          return;
        }
        up.gmail.deliver(message({ ...mail, id: `${mail.id.slice(0, 10)}${Date.now().toString(16).slice(-6)}`, receivedAt: up.gmail.clock() }));
        response.writeHead(204).end();
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
      const answer = await up.handle(new Request(`http://127.0.0.1${request.url ?? '/'}`, { method: request.method ?? 'GET', headers, ...(raw.length > 0 ? { body: raw } : {}) }));
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(new Uint8Array(await answer.arrayBuffer()));
    })();
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const up = new FakeUpstream();
  up.gmail.grants.set(DEV_REFRESH_TOKEN, 'https://www.googleapis.com/auth/gmail.modify');
  const { origin } = await serveFakeUpstream(up, Number(process.argv[2] ?? '8796'));
  console.log(`fake Gmail and Workers AI on ${origin} (DEV_FAKE_UPSTREAM); POST ${origin}/__fake/deliver?mail=newsletterZh delivers a synthetic mail`);
}
