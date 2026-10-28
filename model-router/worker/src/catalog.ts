import { create } from '@ziyixi/proto/protobuf';
import { ModelSchema, type Model } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import type { Env } from './types.ts';
import { invalid } from './errors.ts';

export interface CatalogRoute {
  upstreamModel: string;
  displayName: string;
  provider: 'codex' | 'anthropic' | 'gemini' | 'workers_ai';
  efforts: string[];
  quotaUnitsPerToken?: number;
}
export const ROUTES: readonly CatalogRoute[] = [
  { upstreamModel: 'gpt-6.1-sol', displayName: 'Sol 6.1', provider: 'codex', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { upstreamModel: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', provider: 'anthropic', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { upstreamModel: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', provider: 'anthropic', efforts: ['low', 'medium', 'high'] },
  { upstreamModel: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', provider: 'gemini', efforts: ['low', 'medium', 'high'] },
  { upstreamModel: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', provider: 'gemini', efforts: ['low', 'medium', 'high'] },
  { upstreamModel: '@cf/baai/bge-m3', displayName: 'BGE-M3', provider: 'workers_ai', efforts: [], quotaUnitsPerToken: 0.001075 },
];
const providers = { codex: 'openai', anthropic: 'anthropic', gemini: 'google', workers_ai: 'cloudflare' } as const;
export function providerFor(model: string): string {
  if (model.startsWith('gpt-')) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'google';
  if (model.startsWith('@cf/')) return 'cloudflare';
  return '';
}
export function routeFor(model: string): CatalogRoute {
  const route = ROUTES.find((item) => item.upstreamModel === model);
  if (!route) invalid('MODEL_NOT_FOUND', 'Choose a configured native model.');
  return route;
}
export function secretFor(env: Env, provider: 'anthropic' | 'gemini'): string {
  return (provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.GEMINI_API_KEY)?.trim() ?? '';
}
export function modelCatalog(env: Env): Model[] {
  const codexConfigured = !!(env.CODEX_EXECUTOR_ORIGIN && env.CODEX_ACCESS_CLIENT_ID && env.CODEX_ACCESS_CLIENT_SECRET);
  return ROUTES.map((route) => {
    let configured: boolean;
    switch (route.provider) {
      case 'codex':
        configured = codexConfigured;
        break;
      case 'workers_ai':
        configured = !!env.AI;
        break;
      default:
        configured = !!secretFor(env, route.provider);
    }
    return create(ModelSchema, {
      id: route.upstreamModel,
      displayName: route.displayName,
      provider: providers[route.provider],
      kind: route.provider === 'workers_ai' ? 'embedding' : 'text',
      configured,
      efforts: route.efforts,
      reservationQuotaUnitsPerToken: route.quotaUnitsPerToken ?? 0,
    });
  });
}
