import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { createHttpClient, type HttpCall } from '@ziyixi/proto/http-client'
import { ConsoleService, ModelService } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const origin = 'http://127.0.0.1'
export const machineToken = 'synthetic-newsletter-model-token'
export interface UpstreamCall {
  path: string
  body: Record<string, unknown>
  caller: string | null
  bearer: string | null
}

let bundle: Promise<string> | undefined
function script() {
  bundle ??= build({
    entryPoints: [join(root, 'test/runtime-entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2024',
    conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:workers'],
    write: false,
    logLevel: 'silent',
  }).then((result) => {
    if (!result.outputFiles[0]) throw new Error('No test bundle')
    return result.outputFiles[0].text
  })
  return bundle
}

export async function startHarness({ ownerBypass = true }: { ownerBypass?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'model-router-runtime-'))
  const calls: UpstreamCall[] = []
  const geminiOutputs: string[] = []
  const conversations = new Map<string, string>()
  async function outbound(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const body: unknown = request.method === 'POST' ? await request.json() : {}
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      throw new Error('Synthetic body is not an object')
    const data = body as Record<string, unknown>
    calls.push({
      path: url.pathname,
      body: data,
      caller: request.headers.get('x-inference-caller'),
      bearer: request.headers.get('authorization'),
    })
    if (url.hostname === 'generativelanguage.googleapis.com')
      return Response.json({
        modelVersion: 'synthetic-gemini-reported',
        candidates: [
          { finishReason: 'STOP', content: { parts: [{ text: geminiOutputs.shift() ?? '{"answer":"synthetic"}' }] } },
        ],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
      })
    if (url.hostname !== 'executor.example.test')
      return new Response('Synthetic external request denied', { status: 599 })
    if (url.pathname.endsWith('generations:generate')) {
      const output = {
        name: `requests/${String(data.request_id)}`,
        app: 'synthetic-executor',
        model: 'models/sol-6-1',
        state: 'succeeded',
        output: '{"answer":"synthetic executor result"}',
        usage: { available: true, input_tokens: 14, output_tokens: 5, total_tokens: 19, billing_kind: 'subscription' },
        reported_model: 'synthetic-sol-reported',
        upstream_started: true,
        attempt_count: 1,
        finish_reason: 'complete',
      }
      return new Response(
        `event: ready\ndata: {}\n\nevent: heartbeat\ndata: {}\n\nevent: result\ndata: ${JSON.stringify(output)}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    if (url.pathname.endsWith('/conversations')) {
      const conversation = data
      const name = String(conversation.name)
      conversations.set(name, 'open')
      return Response.json({ ...conversation, state: 'open', app: 'synthetic-executor' })
    }
    const name = url.pathname.replace('/api/codex/v1/model/', '').replace(/:close$/, '')
    if (url.pathname.endsWith(':close')) conversations.set(name, 'closed')
    return Response.json({ name, state: conversations.get(name) ?? 'lost', config: { model: 'models/sol-6-1' } })
  }
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      port: 0,
      resourcePersistencePath: directory,
      workers: [
        {
          name: 'model-router',
          script: await script(),
          modules: true,
          compatibilityDate: '2026-09-08',
          d1Databases: { DB: 'model-router-synthetic' },
          r2Buckets: { REQUEST_BODIES: 'router-synthetic-bodies' },
          durableObjects: { ENGINE: { className: 'RouterEngine', useSQLite: true } },
          bindings: {
            DEV_AUTH_BYPASS: ownerBypass ? 'true' : 'false',
            ACCESS_OWNER: 'owner@example.test',
            ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
            ACCESS_AUDIENCE: 'b'.repeat(64),
            PUBLIC_HOST: 'models.example.test',
            CSRF_SIGNING_KEY: 'cd'.repeat(32),
            CODEX_EXECUTOR_ORIGIN: 'https://executor.example.test',
            CODEX_EXECUTOR_TOKEN: 'synthetic-executor-token',
            GEMINI_API_KEY_TODOFY: 'synthetic-gemini-key',
            MODEL_ROUTER_NEWSLETTER_TOKEN: machineToken,
          },
          serviceBindings: { ASSETS: () => new Response('Synthetic private assets') },
          outboundService: outbound,
        },
        {
          name: 'router-ops-probe',
          modules: true,
          compatibilityDate: '2026-09-08',
          script: `export default {async fetch(request,env){try{return Response.json(new URL(request.url).pathname==='/guard'?await env.OPS.setGuard(await request.json()):await env.OPS.status())}catch(error){return Response.json({error:error.message},{status:400})}}}`,
          serviceBindings: { OPS: { name: 'model-router', entrypoint: 'Ops' } },
        },
        ...['todofy', 'mailsort', 'brief', 'unknown'].map((app) => ({
          name: `caller-${app}`,
          modules: true,
          compatibilityDate: '2026-09-08',
          script: 'export default {fetch(request, env) {return env.MODEL.fetch(request)}}',
          serviceBindings: { MODEL: { name: 'model-router', entrypoint: 'Inference', props: { app } } },
        })),
      ],
    }),
  )
  await mf.ready
  const db = await mf.getD1Database('DB', 'model-router')
  const bucket = await mf.getR2Bucket('REQUEST_BODIES', 'model-router')
  for (const filename of (await readdir(join(root, '../migrations'))).filter((file) => file.endsWith('.sql')).sort()) {
    const sql = await readFile(join(root, '../migrations', filename), 'utf8')
    for (const statement of sql
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean))
      await db.prepare(statement).run()
  }
  let csrfToken = ''
  let cookie = ''
  async function send(call: HttpCall) {
    if (call.httpMethod !== 'GET' && !csrfToken) {
      const session = await mf.dispatchFetch(`${origin}/api/session`)
      const value = (await session.json()) as { csrf_token: string }
      csrfToken = value.csrf_token
      cookie = session.headers.get('set-cookie')?.split(';')[0] ?? ''
    }
    return mf.dispatchFetch(origin + call.url, {
      method: call.httpMethod,
      headers: { 'content-type': 'application/json', origin, cookie, 'x-csrf-token': csrfToken },
      ...(call.body === undefined ? {} : { body: call.body }),
    }) as unknown as Promise<Response>
  }
  const owner = createHttpClient(ConsoleService, send)
  const models = createHttpClient(ModelService, send)
  const forCaller = (app: string) =>
    createHttpClient(ModelService, async (call) => {
      const worker = await mf.getWorker(`caller-${app}`)
      return worker.fetch(origin + call.url, {
        method: call.httpMethod,
        headers: { 'content-type': 'application/json' },
        ...(call.body === undefined ? {} : { body: call.body }),
      }) as unknown as Promise<Response>
    })
  async function caller(app: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
    const worker = await mf.getWorker(`caller-${app}`)
    return worker.fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  return {
    mf,
    db,
    bucket,
    owner,
    models,
    forCaller,
    calls,
    geminiOutputs,
    caller,
    async dispose() {
      await mf.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
