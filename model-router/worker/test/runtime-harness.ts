import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { createHttpClient, type HttpCall } from '@ziyixi/proto/http-client'
import { ModelService } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb'
import { ConsoleService } from '@ziyixi/proto/modelrouter/inference/v1/console_pb'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const origin = 'http://127.0.0.1'
export const machineToken = 'synthetic-newsletter-model-token'
export interface UpstreamCall {
  path: string
  body: Record<string, unknown>
  caller: string | null
  bearer: string | null
  userAgent: string | null
}

const issuer = 'https://synthetic.cloudflareaccess.com'
const audience = 'b'.repeat(64)
const ownerEmail = 'owner@example.test'
const signingKeys = generateKeyPair('RS256').then(async ({ privateKey, publicKey }) => ({
  privateKey,
  jwks: { keys: [{ ...await exportJWK(publicKey), alg: 'RS256', use: 'sig', kid: 'synthetic-owner-key' }] },
}))

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

export async function startHarness({ ownerBypass = true, maintenance = false }: { ownerBypass?: boolean; maintenance?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'model-router-runtime-'))
  const calls: UpstreamCall[] = []
  const geminiOutputs: string[] = []
  const executorOutputs: string[] = []
  const conversations = new Map<string, string>()
  let generationFailureReason = ''
  let geminiDelayMs = 0
  async function outbound(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.href === `${issuer}/cdn-cgi/access/certs`) return Response.json((await signingKeys).jwks)
    const body: unknown = request.method === 'POST' ? await request.json() : {}
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      throw new Error('Synthetic body is not an object')
    const data = body as Record<string, unknown>
    calls.push({
      path: url.pathname,
      body: data,
      caller: request.headers.get('x-inference-caller'),
      bearer: request.headers.get('authorization'),
      userAgent: request.headers.get('user-agent'),
    })
    if (url.hostname === 'generativelanguage.googleapis.com') {
      const delay = geminiDelayMs
      geminiDelayMs = 0
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      return Response.json({
        modelVersion: 'gemini-3.5-flash-lite',
        candidates: [
          { finishReason: 'STOP', content: { parts: [{ text: geminiOutputs.shift() ?? '{"answer":"synthetic"}' }] } },
        ],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
      })
    }
    if (url.hostname !== 'executor.example.test')
      return new Response('Synthetic external request denied', { status: 599 })
    if (url.pathname.endsWith('generations:generate')) {
      if (generationFailureReason) {
        const reason = generationFailureReason
        generationFailureReason = ''
        return Response.json({ error: { code: 503, status: 'UNAVAILABLE', message: 'Synthetic unavailable', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'modelrouter.inference.v1' }] } }, { status: 503 })
      }
      const output = {
        name: `requests/${crypto.randomUUID()}`,
        model: 'gpt-6.1-sol',
        output: executorOutputs.shift() ?? '{"answer":"synthetic executor result"}',
        usage: { available: true, input_tokens: 14, output_tokens: 5, billing_kind: 'subscription' },
        ...(data.conversation ? { observations: { searched: true, opened_urls: ['https://example.test/synthetic-research-evidence'] } } : {}),
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
      return Response.json({})
    }
    const name = url.pathname.replace('/api/codex/v1/model/', '').replace(/:close$/, '')
    if (url.pathname.endsWith(':close')) conversations.set(name, 'closed')
    return Response.json({})
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
          r2Buckets: { REQUEST_BODIES: 'router-synthetic-bodies', BACKUPS: 'router-synthetic-backups' },
          durableObjects: { ENGINE: { className: 'RouterEngine', useSQLite: true } },
          bindings: {
            DEV_AUTH_BYPASS: ownerBypass ? 'true' : 'false',
            MAINTENANCE_MODE: String(maintenance),
            ACCESS_OWNER: ownerEmail,
            ACCESS_ISSUER: issuer,
            ACCESS_AUDIENCE: audience,
            PUBLIC_HOST: 'models.example.test',
            CODEX_EXECUTOR_ORIGIN: 'https://executor.example.test',
            CODEX_ACCESS_CLIENT_ID: 'synthetic-access-id',
            CODEX_ACCESS_CLIENT_SECRET: 'synthetic-access-secret',
            GEMINI_API_KEY: 'synthetic-gemini-key',
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
        ...['todofy', 'mailsort', 'unknown'].map((app) => ({
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
  const backups = await mf.getR2Bucket('BACKUPS', 'model-router')
  for (const filename of (await readdir(join(root, '../migrations'))).filter((file) => file.endsWith('.sql')).sort()) {
    const sql = await readFile(join(root, '../migrations', filename), 'utf8')
    for (const statement of sql
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean))
      await db.prepare(statement).run()
  }
  async function send(call: HttpCall) {
    return mf.dispatchFetch(origin + call.url, {
      method: call.httpMethod,
      headers: { 'content-type': 'application/json', origin, 'x-csrf-token': '1' },
      ...(call.body === undefined ? {} : { body: call.body }),
    }) as unknown as Promise<Response>
  }
  const owner = createHttpClient(ConsoleService, send)
  const models = createHttpClient(ModelService, send)
  const newsletter = createHttpClient(ModelService, async (call) =>
    mf.dispatchFetch(origin + call.url, {
      method: call.httpMethod,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${machineToken}` },
      ...(call.body === undefined ? {} : { body: call.body }),
    }) as unknown as Promise<Response>)
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
  async function ownerToken() {
    return new SignJWT({ email: ownerEmail })
      .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-owner-key' })
      .setIssuer(issuer).setAudience(audience).setSubject('synthetic-owner')
      .setIssuedAt().setExpirationTime('1h').sign((await signingKeys).privateKey)
  }
  return {
    ownerToken,
    mf,
    db,
    bucket,
    backups,
    owner,
    models,
    newsletter,
    forCaller,
    calls,
    geminiOutputs,
    executorOutputs,
    failNextGeneration(reason: string) { generationFailureReason = reason },
    delayNextGemini(ms: number) { geminiDelayMs = ms },
    caller,
    async dispose() {
      await mf.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
