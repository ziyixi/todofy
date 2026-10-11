/**
 * Claude API prices and cost accounting (../../docs/design.md §13), per million tokens, from the pricing page on
 * 2026-10-10: Claude Opus 5.5 $4 input, $5 cache write (5 minutes), $0.20 cache read, $20 output; Claude Opus 5 and
 * Claude Opus 4.8, the server-side fallback targets, $5 input and $25 output (cache writes 1.25x and reads 0.1x of
 * input); Claude Haiku 5.5 $0.10, $0.125, $0.01, $0.50 for prompts up to 100K tokens and $0.50, $0.625, $0.05, $2.50
 * above. Every call's `usage` becomes dollars: `input_tokens` is only the uncached rest, output includes thinking, and
 * with fallbacks every entry of `usage.iterations` is summed at its own model's prices (a declined attempt, whose entry
 * does not name its model, at the requested model's).
 */

export interface Price {
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
}

const OPUS_FALLBACK: Price = { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 };

export const PRICES: Readonly<Record<string, Price>> = {
  'claude-opus-5-5': { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  'claude-opus-5': OPUS_FALLBACK,
  'claude-opus-4-8': OPUS_FALLBACK,
  'claude-haiku-5-5': { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
};

/** Haiku 5.5's rate card for prompts above 100K tokens. */
const HAIKU_LONG: Price = { input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 };
const HAIKU_LONG_ABOVE = 100_000;

/** The dearest model a request to `model` may be served by: an Opus request's fallbacks, else the model itself. */
export function dearestPrice(model: string): Price {
  if (model.startsWith('claude-opus')) return OPUS_FALLBACK;
  if (model === 'claude-haiku-5-5') return HAIKU_LONG;
  return PRICES[model] ?? OPUS_FALLBACK;
}

/** The price of one model, for a prompt of `promptTokens`; an unknown model at the dearest known prices. */
export function priceOf(model: string, promptTokens = 0): Price {
  if (model === 'claude-haiku-5-5' && promptTokens > HAIKU_LONG_ABOVE) return HAIKU_LONG;
  const exact = PRICES[model];
  if (exact !== undefined) return exact;
  // Dated or suffixed IDs of a known model (`claude-opus-5-20260601`).
  const known = Object.keys(PRICES).find((name) => model.startsWith(`${name}-`));
  return known === undefined ? OPUS_FALLBACK : (PRICES[known] ?? OPUS_FALLBACK);
}

/** The usage fields the cost reads (the SDK's BetaUsage and its iteration entries share them). */
export interface UsageLike {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly iterations?: readonly IterationLike[] | null;
}

export interface IterationLike extends UsageLike {
  readonly type?: string;
  readonly model?: string | null;
}

export interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
}

function n(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function dollars(tokens: Tokens, price: Price): number {
  return (tokens.input * price.input + tokens.cacheWrite * price.cacheWrite + tokens.cacheRead * price.cacheRead + tokens.output * price.output) / 1_000_000;
}

function tokensOf(usage: UsageLike): Tokens {
  return { input: n(usage.input_tokens), output: n(usage.output_tokens), cacheWrite: n(usage.cache_creation_input_tokens), cacheRead: n(usage.cache_read_input_tokens) };
}

/** A call's cost and tokens from its usage: the iterations at their own models' prices when there are any. */
export function costOfUsage(usage: UsageLike, requestedModel: string, servedModel: string): { cost: number; tokens: Tokens } {
  const iterations = (usage.iterations ?? []).filter((entry) => entry.type === undefined || entry.type === 'message' || entry.type === 'fallback_message');
  if (iterations.length === 0) {
    const tokens = tokensOf(usage);
    return { cost: dollars(tokens, priceOf(servedModel, tokens.input + tokens.cacheRead + tokens.cacheWrite)), tokens };
  }
  let cost = 0;
  const total = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const entry of iterations) {
    const tokens = tokensOf(entry);
    const model = typeof entry.model === 'string' && entry.model !== '' ? entry.model : requestedModel;
    cost += dollars(tokens, priceOf(model, tokens.input + tokens.cacheRead + tokens.cacheWrite));
    total.input += tokens.input;
    total.output += tokens.output;
    total.cacheWrite += tokens.cacheWrite;
    total.cacheRead += tokens.cacheRead;
  }
  return { cost, tokens: total };
}

/**
 * A call's reservation (design §13, the first wall): its estimated input and `max_tokens` at the dearest model that
 * may serve it (an Opus call at its fallbacks' $5/$25: about $1.85 for a 64K write).
 */
export function reservationOf(model: string, estimatedInputTokens: number, maxTokens: number): number {
  const price = dearestPrice(model);
  return (estimatedInputTokens * price.input + maxTokens * price.output) / 1_000_000;
}

/** A rough token count of a prompt: a CJK character about one token, other text about four characters a token. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xff00 && code <= 0xffef)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 3.5);
}
