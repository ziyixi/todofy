/**
 * The fake Workers AI as a binding (an RPC entrypoint with the binding's one method, `run`), for the workerd suite:
 * the Worker calls env.AI as in production. `setQuota` lets a test make it refuse as the daily allocation does.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { FakeAi } from './ai.ts';

const ai = new FakeAi();

export class FakeAiBinding extends WorkerEntrypoint {
  run(model: string, input: Record<string, unknown>): Record<string, unknown> {
    return ai.run(model, input);
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const { quota } = await request.json<{ quota?: boolean }>();
    if (quota !== undefined) ai.quota = quota;
    return Response.json({ calls: ai.calls, quota: ai.quota });
  },
};
