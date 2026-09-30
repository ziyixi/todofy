/**
 * The Workers AI models Lab may call, with their neuron rates (docs/design.md §1, §5). Every AI call is
 * priced from this table before it runs, so a model outside it is never called. Rates are neurons per
 * million tokens from the pricing page, checked 2026-09-30; re-check the page before changing a value.
 */
export const PRICING_URL = 'https://developers.cloudflare.com/workers-ai/platform/pricing/';

export interface ModelRate {
  readonly kind: 'embedding' | 'text';
  /** Neurons per million input tokens. */
  readonly inPerM: number;
  /** Neurons per million output tokens (0 for embeddings). */
  readonly outPerM: number;
}

export const EMBED_MODEL = '@cf/baai/bge-m3';
/** Output width of EMBED_MODEL; vectors are stored as this many Float32 values. */
export const EMBED_DIMENSIONS = 1024;
/** Texts per embedding call (docs/design.md §4). */
export const EMBED_BATCH_MAX = 50;
export const DEFAULT_TLDR_MODEL = '@cf/ibm-granite/granite-4.0-h-micro';

export const MODEL_RATES = {
  '@cf/baai/bge-m3': { kind: 'embedding', inPerM: 1075, outPerM: 0 },
  '@cf/ibm-granite/granite-4.0-h-micro': { kind: 'text', inPerM: 1542, outPerM: 10158 },
  '@cf/meta/llama-3.2-1b-instruct': { kind: 'text', inPerM: 2457, outPerM: 18252 },
  '@cf/qwen/qwen3-30b-a3b-fp8': { kind: 'text', inPerM: 4625, outPerM: 30475 },
} as const satisfies Readonly<Record<string, ModelRate>>;

export type ModelId = keyof typeof MODEL_RATES;
export const TLDR_MODELS = ['@cf/ibm-granite/granite-4.0-h-micro', '@cf/meta/llama-3.2-1b-instruct', '@cf/qwen/qwen3-30b-a3b-fp8'] as const satisfies readonly ModelId[];
export type TldrModel = (typeof TLDR_MODELS)[number];
