import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { migrationStatements } from './migrations.mjs'

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

export async function buildWorker(options) {
  const {
    contents,
    entryPoints,
    sourcefile = 'worker-entry.ts',
    external = ['cloudflare:workers'],
  } = typeof options === 'string' ? { contents: options } : options
  const result = await build({
    ...(entryPoints
      ? { entryPoints }
      : { stdin: { contents, resolveDir: ROOT, sourcefile, loader: 'ts' } }),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['browser'],
    external,
    write: false,
  })
  return result.outputFiles[0].text
}

export function createMiniflare(options) {
  const base = { compatibilityDate: '2026-09-07', modules: true }
  const v4 = options.workers
    ? {
        host: '127.0.0.1',
        port: 0,
        ...options,
        workers: options.workers.map(worker => ({ ...base, ...worker })),
      }
    : { ...base, host: '127.0.0.1', port: 0, ...options }
  return new Miniflare(convertV4MiniflareOptions(v4))
}

export async function migrateD1(db) {
  const directory = join(ROOT, 'migrations')
  for (const name of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
    const sql = await readFile(join(directory, name), 'utf8')
    await db.batch(migrationStatements(sql).map(statement => db.prepare(statement)))
  }
  return db
}

export async function startRuntime({
  prefix = 'mail-hero-runtime-',
  script,
  entry,
  d1 = 'DB',
  d1Worker,
  persist = true,
  ...options
} = {}) {
  const temp = persist ? await mkdtemp(join(tmpdir(), prefix)) : null
  const workerScript = script ?? (entry ? await buildWorker(entry) : undefined)
  const persistence = temp
    ? {
        ...(options.d1Databases || options.workers ? { d1Persist: join(temp, 'd1') } : {}),
        ...(options.r2Buckets || options.workers ? { r2Persist: join(temp, 'r2') } : {}),
        ...(options.durableObjects || options.workers ? { durableObjectsPersist: join(temp, 'do') } : {}),
      }
    : {}
  const mf = createMiniflare({
    ...(workerScript ? { script: workerScript } : {}),
    ...persistence,
    ...options,
  })
  await mf.ready
  const db =
    d1 && (options.d1Databases?.[d1] || d1Worker)
      ? await migrateD1(await mf.getD1Database(d1, d1Worker))
      : null
  async function close() {
    await mf.dispose()
    if (temp) await rm(temp, { recursive: true, force: true })
  }
  return { mf, db, temp, close }
}
