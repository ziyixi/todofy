/** Deploy-time secret assembly; runtime apps never import this tool. */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const specs = JSON.parse(readFileSync(new URL('./worker-secrets.json', import.meta.url), 'utf8'))
// The core's retired secrets, as todofy/deploy/deploy_vars.py RETIRED_CORE_SECRETS: older maps may retain them.
const RETIRED_CORE_SECRETS = ['GEMINI_API_KEY', 'TODOIST_API_KEY', 'TODOIST_DEFAULT_PROJECT_ID', 'TODOIST_OPS_PROJECT_ID',
  'TODOIST_REVIEW_PROJECT_ID']
// The keyless owner apps whose older maps may still hold the retired CSRF key.
const KEYLESS = ['home', 'links', 'watch', 'mailsort', 'recall', 'tasks', 'todofy', 'model-router']

export function workerSecretSpec(worker) {
  const spec = specs[worker]
  if (!spec) throw new Error('Unknown Worker secret declaration')
  return spec
}

/** Empty GitHub secret means legacy deployment. A supplied map must be complete after personal overlay. */
export function mergeWorkerSecrets(worker, env, personal, SettingError) {
  const spec = workerSecretSpec(worker)
  const raw = env[spec.github_secret]
  const required = env.REQUIRE_COMPLETE_WORKER_SECRETS
  if (required !== undefined && required !== '' && required !== 'true' && required !== 'false') {
    throw new SettingError('REQUIRE_COMPLETE_WORKER_SECRETS')
  }
  if (raw === undefined || raw === '') {
    if (required === 'true' && spec.required.length + spec.optional.length > 0) throw new SettingError(spec.github_secret)
    return personal
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new SettingError(spec.github_secret) }
  if (KEYLESS.includes(spec.identity_from ?? worker)
    && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) delete parsed.CSRF_SIGNING_KEY
  if (spec.identity_from) {
    // A borrowed owner identity (cloud_profile.py identity_from): the source's map must be a valid (possibly partial)
    // map of the source, and only the keys this Worker declares are taken from it, so none of the source's other
    // bindings (its tokens) can reach this Worker.
    if (!validWorkerSecrets(spec.identity_from, parsed, false)) throw new SettingError(spec.github_secret)
    parsed = Object.fromEntries([...spec.required, ...spec.optional]
      .filter((name) => Object.hasOwn(parsed, name)).map((name) => [name, parsed[name]]))
  }
  if (worker === 'todofy-core' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const name of RETIRED_CORE_SECRETS) delete parsed[name]
  }
  if (!validWorkerSecrets(worker, parsed, false)) throw new SettingError(spec.github_secret)
  const merged = { ...parsed, ...personal }
  if (!validWorkerSecrets(worker, merged, true)) throw new SettingError(spec.github_secret)
  return merged
}

/** Reject undeclared bindings and non-string/empty values without including the value in diagnostics. */
export function validWorkerSecrets(worker, content, complete) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return false
  const { required, optional } = workerSecretSpec(worker)
  const allowed = new Set([...required, ...optional])
  if (!Object.entries(content).every(([name, value]) => allowed.has(name)
    && typeof value === 'string' && value.length > 0 && value.length <= 65536 && !value.includes('\0'))) return false
  return !complete || required.every((name) => Object.hasOwn(content, name))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  class SettingError extends Error {
    constructor(name) { super(`Invalid or missing deploy setting: ${name}`) }
  }
  try {
    const [command, worker, path, ...extra] = process.argv.slice(2)
    if (command !== 'secrets' || !worker || !path || extra.length) throw new Error('usage')
    const secrets = mergeWorkerSecrets(worker, process.env, {}, SettingError)
    writeFileSync(path, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    console.log('Wrote the Worker secrets file (values not printed).')
  } catch (error) {
    console.error(error instanceof SettingError ? error.message
      : error?.code === 'EEXIST' ? 'The secrets file already exists; nothing was overwritten.'
        : 'Unable to prepare the Worker secrets file.')
    process.exitCode = 1
  }
}
