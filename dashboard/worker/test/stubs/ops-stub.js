// Stub of one app's `Ops` entrypoint for the workerd suite (test/runtime/harness.ts). The harness
// fills in the three constants below (app name, declared methods, contracts/ops-v1 fixtures) first.
// Only the methods ops-v1.ts declares for this app exist, so a call to anything else rejects in RPC.
// A scenario (POST /__scenario) sets per-method answers: {value} or {throw: code} or a {sequence} of
// them; every call is recorded (GET /__calls drains the log).
import { WorkerEntrypoint } from 'cloudflare:workers'

const APP = __APP__
const METHODS = __METHODS__
const DEFAULTS = __DEFAULTS__
let scenario = {}
const calls = []

function answer(method, args) {
  calls.push({ app: APP, method, args })
  let entry = scenario[method]
  if (entry && Array.isArray(entry.sequence)) entry = entry.sequence.length > 1 ? entry.sequence.shift() : entry.sequence[0]
  if (entry && typeof entry.throw === 'string') throw new Error(entry.throw)
  if (entry && 'value' in entry) return structuredClone(entry.value)
  if (!(method in DEFAULTS)) throw new Error('unavailable')
  return structuredClone(DEFAULTS[method])
}

class Base extends WorkerEntrypoint {}
const prototype = {}
for (const method of METHODS) {
  prototype[method] = { async value(...args) { return answer(method, args) }, writable: true, configurable: true }
}
export class Ops extends Base {}
Object.defineProperties(Ops.prototype, prototype)

export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/__scenario' && request.method === 'POST') { scenario = await request.json(); return new Response(null, { status: 204 }) }
    if (url.pathname === '/__calls') return Response.json(calls.splice(0))
    return new Response('stub', { status: 404 })
  },
}
