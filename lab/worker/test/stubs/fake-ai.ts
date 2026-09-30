/**
 * The fake Workers AI binding of the workerd suite: an entrypoint "FakeAi" with the one method Lab calls,
 * `run(model, inputs)`, bound as `AI` through a service binding. Embeddings are deterministic
 * (test/feeds.ts fakeEmbedding); text models answer a fixed Chinese summary with `usage`. A scenario
 * (POST /__scenario) makes calls fail like the account allowance or a transient error.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { fakeEmbedding } from '../feeds.ts';

interface Scenario {
  fail?: 'allowance' | 'error' | null;
  /** The text answer; default a valid 3-sentence 简介. */
  text?: string;
}

let scenario: Scenario = {};
const calls: { model: string; count: number }[] = [];

export class FakeAi extends WorkerEntrypoint {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown> {
    const texts = Array.isArray(inputs['text']) ? (inputs['text'] as string[]) : [];
    calls.push({ model, count: model === '@cf/baai/bge-m3' ? texts.length : 1 });
    if (scenario.fail === 'allowance') return Promise.reject(new Error('4006: you have used up your daily free allocation of 10,000 neurons'));
    if (scenario.fail === 'error') return Promise.reject(new Error('InferenceUpstreamError'));
    if (model === '@cf/baai/bge-m3') {
      return Promise.resolve({ shape: [texts.length, 1024], data: texts.map((t) => fakeEmbedding(t)), pooling: 'cls' });
    }
    return Promise.resolve({
      response: scenario.text ?? '本文提出一种合成的检索方法。作者在玩具数据集上评估。结果显示召回率有所提升。',
      usage: { prompt_tokens: 600, completion_tokens: 80, total_tokens: 680 },
    });
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__scenario' && request.method === 'POST') {
      scenario = await request.json();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/__calls') return Response.json(calls.splice(0));
    return new Response('stub', { status: 404 });
  },
};
