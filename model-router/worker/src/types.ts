import type { GenerationConfig, Parameters, Usage } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import type { CatalogRoute } from './catalog.ts';

export interface Env {
  DB: D1Database;
  REQUEST_BODIES: R2Bucket;
  ENGINE: DurableObjectNamespace;
  ASSETS: Fetcher;
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  BUILD_SHA?: string;
  PUBLIC_HOST?: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUDIENCE?: string;
  ACCESS_OWNER?: string;
  ACCESS_OWNER_ALIASES?: string;
  DEV_AUTH_BYPASS?: string;
  CODEX_EXECUTOR_ORIGIN?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  CODEX_ACCESS_CLIENT_ID?: string;
  CODEX_ACCESS_CLIENT_SECRET?: string;
  MODEL_ROUTER_NEWSLETTER_TOKEN?: string;
  [name: string]: unknown;
}
export interface ProviderContext {
  env: Env;
  caller: string;
  requestId: string;
  route: CatalogRoute;
  signal: AbortSignal;
  deadlineMs: number;
  fetcher: typeof fetch;
  history?: { role: 'user' | 'assistant'; content: string }[];
}
export type TokenUsage = Omit<Usage, '$typeName'>;
export interface ProviderResult {
  output: string;
  reportedModel: string;
  usage: TokenUsage;
  observations: { searched: boolean; openedUrls: string[] };
  error?: { code: number; message: string; details: []; reason?: string; retryAfterSeconds?: number };
  parameters: Omit<Parameters, '$typeName'>;
  upstreamStarted?: boolean;
  attemptCount?: number;
  finishReason?: string;
  contributingModels?: string[];
}
export interface EmbeddingResult {
  vectors: number[][];
  dimensions: number;
  usage: TokenUsage;
  error?: { code: number; message: string; details: []; reason?: string; retryAfterSeconds?: number };
}
export type Provider = (config: GenerationConfig, input: string, context: ProviderContext) => Promise<ProviderResult>;
