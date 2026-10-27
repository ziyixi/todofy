import worker from '../src/index.ts'
import type { Env } from '../src/types.ts'

export { Inference, RouterEngine, Ops } from '../src/index.ts'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === '/__test/cleanup') {
      await worker.scheduled({} as ScheduledController, env)
      return new Response(null, { status: 204 })
    }
    return worker.fetch(request, env)
  },
}
