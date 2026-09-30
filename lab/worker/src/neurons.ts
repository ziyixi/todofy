/**
 * Neuron arithmetic of the hard daily cap (docs/design.md §5). Every AI call is priced before it runs
 * from an upper-bound token estimate and charged in full before the call (so a crash never under-counts);
 * a text model's reported usage then replaces the estimate. Pure functions; LabState keeps the ledger.
 */
import { MODEL_RATES, type ModelId } from './models.ts';

/** Upper bound of tokens for `text`: one token per 3 UTF-8 bytes, at least 1. */
export function tokenBound(text: string): number {
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 3));
}

/** Neurons for `input` and `output` tokens on `model`, rounded up to 1/1000. */
export function neuronsFor(model: ModelId, input: number, output: number): number {
  const rate = MODEL_RATES[model];
  return Math.ceil(((input * rate.inPerM + output * rate.outPerM) / 1_000_000) * 1000) / 1000;
}

export function embedEstimate(model: ModelId, texts: readonly string[]): number {
  return neuronsFor(model, texts.reduce((sum, text) => sum + tokenBound(text), 0), 0);
}

export function textEstimate(model: ModelId, prompt: string, maxTokens: number): number {
  return neuronsFor(model, tokenBound(prompt), maxTokens);
}

/** The effective cap: the lower of the deployment ceiling and the owner's setting (never above the ceiling). */
export function effectiveCap(ceiling: number, setting: number | null): number {
  if (setting === null || !Number.isFinite(setting)) return ceiling;
  return Math.max(0, Math.min(ceiling, Math.floor(setting)));
}

/** True when a call costing `estimate` would stay within `cap` after `used`. */
export function fits(used: number, estimate: number, cap: number): boolean {
  return used + estimate <= cap;
}

/**
 * Whether a Workers AI error means the account's daily allowance is gone (Free plan: calls past 10,000
 * neurons fail). Matched on the error text only; nothing of it is stored or logged.
 */
export function isAllowanceError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /\b(3036|4006)\b|neuron|daily (free )?allocation|allocation.*exceeded|quota/i.test(text);
}

/** The tokens a text model reported (`usage.prompt_tokens/completion_tokens`), or null. */
export function reportedUsage(output: unknown): { input: number; output: number } | null {
  if (typeof output !== 'object' || output === null) return null;
  const usage = (output as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const { prompt_tokens: input, completion_tokens: out } = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  if (typeof input !== 'number' || typeof out !== 'number' || !Number.isFinite(input) || !Number.isFinite(out) || input < 0 || out < 0) return null;
  return { input, output: out };
}
