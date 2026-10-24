/**
 * The fake Workers AI as a binding (an RPC entrypoint with the binding's one method, `run`), for the workerd tests that
 * run without the development bypass (the CPU test): there the Worker calls env.AI as in production.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { FakeAi } from './fake-ai.ts';

const ai = new FakeAi();
// This binding serves CPU tests: always measure embeddings, both decision views and the write path.
ai.choiceOverride = () => ({ p2: 0.92, none: 0.08 });

export class FakeAiBinding extends WorkerEntrypoint {
  run(model: string, input: Record<string, unknown>): Record<string, unknown> {
    return ai.run(model, input);
  }
}

export default {
  fetch(): Response {
    return new Response('fake Workers AI', { status: 404 });
  },
};
