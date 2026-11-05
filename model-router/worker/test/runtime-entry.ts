import worker, { Inference, RouterEngine, Ops } from '../src/index.ts'
import { backupStep, type BackupCursor } from '../src/backup.ts'
import type { Env } from '../src/types.ts'

export { Inference, RouterEngine, Ops }

type TestableRouterEngine = RouterEngine & { setTestBackupTime(time: number): Promise<void> }

;(RouterEngine.prototype as TestableRouterEngine).setTestBackupTime = async function (this: RouterEngine, time: number) {
  const ctx = (this as unknown as { ctx: DurableObjectState }).ctx
  await ctx.storage.delete('backup')
  await ctx.storage.put('last-backup', { time, requests: 0, bodies: 0, body_bytes: 0 })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname
    if (pathname === '/__test/backup-step') {
      return Response.json(await backupStep(env, await request.json<BackupCursor>()))
    }
    if (pathname === '/__test/set-backup-time') {
      const { time } = await request.json<{ time: number }>()
      const engine = env.ENGINE.get(env.ENGINE.idFromName('router-v1')) as DurableObjectStub<TestableRouterEngine>
      await engine.setTestBackupTime(time)
      return new Response(null, { status: 204 })
    }
    if (pathname === '/__test/cleanup') {
      await worker.scheduled({} as ScheduledController, env)
      return new Response(null, { status: 204 })
    }
    return worker.fetch(request, env)
  },
}
