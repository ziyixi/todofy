import { create } from '@ziyixi/proto/protobuf';
import { ModelSchema, type Model } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import type { Env } from './types.ts';
import { invalid } from './errors.ts';

export interface CatalogRoute {
  name: string;
  displayName: string;
  provider: 'codex' | 'anthropic' | 'gemini' | 'workers_ai';
  upstreamModel: string;
  fallbackModels?: string[];
  efforts: string[];
  generation: boolean;
  embeddings: boolean;
  conversations: boolean;
  webResearch: boolean;
  temperature: boolean;
  maxOutputTokens: boolean;
  dimensions: number;
  quotaUnitsPerToken?: number;
}
const generation = { generation: true, embeddings: false, conversations: true, webResearch: false, dimensions: 0 };
const gemini = {
  ...generation,
  provider: 'gemini' as const,
  efforts: ['low', 'medium', 'high'],
  temperature: true,
  maxOutputTokens: true,
};
export const ROUTES: readonly CatalogRoute[] = [
  {
    ...generation,
    name: 'models/sol-6-1',
    displayName: 'Sol 6.1',
    provider: 'codex',
    upstreamModel: 'gpt-6.1-sol',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    webResearch: true,
    temperature: false,
    maxOutputTokens: false,
  },
  {
    ...generation,
    name: 'models/claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    provider: 'anthropic',
    upstreamModel: 'claude-opus-5-5',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    temperature: false,
    maxOutputTokens: true,
  },
  {
    ...generation,
    name: 'models/claude-haiku-5-5',
    displayName: 'Claude Haiku 5.5',
    provider: 'anthropic',
    upstreamModel: 'claude-haiku-5-5',
    efforts: ['low', 'medium', 'high'],
    temperature: true,
    maxOutputTokens: true,
  },
  { ...gemini, name: 'models/gemini-3-8-flash', displayName: 'Gemini 3.8 Flash', upstreamModel: 'gemini-3.8-flash' },
  { ...gemini, name: 'models/gemini-3-7-flash', displayName: 'Gemini 3.7 Flash', upstreamModel: 'gemini-3.7-flash' },
  {
    ...gemini,
    name: 'models/gemini-3-5-flash-lite',
    displayName: 'Gemini 3.5 Flash-Lite',
    upstreamModel: 'gemini-3.5-flash-lite',
  },
  {
    ...gemini,
    name: 'models/gemini-email',
    displayName: 'Gemini 邮件摘要链',
    upstreamModel: 'gemini-3.5-flash-lite',
    fallbackModels: ['gemini-3.8-flash', 'gemini-3.7-flash'],
  },
  {
    ...gemini,
    name: 'models/gemini-report',
    displayName: 'Gemini 日报推荐链',
    upstreamModel: 'gemini-3.8-flash',
    fallbackModels: ['gemini-3.7-flash', 'gemini-3.5-flash-lite'],
  },
  {
    name: 'models/bge-m3',
    displayName: 'BGE-M3',
    provider: 'workers_ai',
    upstreamModel: '@cf/baai/bge-m3',
    efforts: [],
    generation: false,
    embeddings: true,
    conversations: false,
    webResearch: false,
    temperature: false,
    maxOutputTokens: false,
    dimensions: 1024,
    quotaUnitsPerToken: 0.001075,
  },
];
export function routeFor(name: string): CatalogRoute {
  // Existing frozen Newsletter runs retain their original model identifier.
  const route = ROUTES.find((item) => item.name === name || item.upstreamModel === name);
  if (!route) invalid('MODEL_NOT_FOUND', 'Choose a configured model.');
  return route;
}
export function secretFor(env: Env, provider: 'anthropic' | 'gemini'): string {
  return (provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.GEMINI_API_KEY)?.trim() ?? '';
}
export async function modelCatalog(env: Env): Promise<Model[]> {
  const executorConfigured = !!(env.CODEX_EXECUTOR_ORIGIN && env.CODEX_ACCESS_CLIENT_ID && env.CODEX_ACCESS_CLIENT_SECRET);
  const executorConnection = executorConfigured
    ? [env.CODEX_EXECUTOR_ORIGIN, env.CODEX_ACCESS_CLIENT_ID, env.CODEX_ACCESS_CLIENT_SECRET].join('\0')
    : '';
  return Promise.all(
    ROUTES.map(async (route) => {
      const secret =
        route.provider === 'codex'
          ? executorConnection
          : route.provider === 'workers_ai'
            ? ''
            : secretFor(env, route.provider);
      const digest = secret
        ? new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))
        : new Uint8Array();
      return create(ModelSchema, {
        name: route.name,
        displayName: route.displayName,
        provider: route.provider,
        upstreamModel: route.upstreamModel,
        configured:
          route.provider === 'codex'
            ? executorConfigured
            : route.provider === 'workers_ai'
              ? !!env.AI
              : !!secretFor(env, route.provider),
        generation: route.generation,
        embeddings: route.embeddings,
        conversations: route.conversations,
        webResearch: route.webResearch,
        efforts: route.efforts,
        temperature: route.temperature,
        maxOutputTokens: route.maxOutputTokens,
        dimensions: route.dimensions,
        reservationInputMicrousdPerToken:
          route.provider === 'anthropic' ? (route.upstreamModel.startsWith('claude-opus') ? 5 : 0.5) : 0,
        reservationOutputMicrousdPerToken:
          route.provider === 'anthropic' ? (route.upstreamModel.startsWith('claude-opus') ? 25 : 2.5) : 0,
        connectionRevision: Array.from(digest.slice(0, 6), (byte) => byte.toString(16).padStart(2, '0')).join(''),
        reservationQuotaUnitsPerToken: route.quotaUnitsPerToken ?? 0,
      });
    }),
  );
}
