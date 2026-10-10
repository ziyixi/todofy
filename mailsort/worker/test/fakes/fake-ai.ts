/**
 * A fake Workers AI for the tests and the local smoke run: the decision models Clef and Clef-flash (the input and output
 * schemas of @cf/cloudflare/clef) and the embedding model bge-m3, deterministic and offline.
 *
 * Clef: an option scores when a word of its description (two or more characters, split at spaces and Chinese or
 * ASCII punctuation) occurs in the state's subject, snippet or body; the best option gets `confidence`, the rest share
 * what is left, and with no match "none" gets it. `suspicious` is high for the phrases of the synthetic phishing mail,
 * `needs_action` for a pickup or verification code, a payment due or a deadline, `bulk` for a mailing list. bge-m3: a
 * hashed bag of character trigrams, normalized (similar text, similar vector). `quota` makes every call fail like the
 * account's exhausted daily allocation; `choiceOverride` answers a view's `choice` as a test sets it (by the options
 * it was offered).
 */

export interface ClefCall {
  readonly model: string;
  readonly input: Record<string, unknown>;
}

export const QUOTA_MESSAGE = '4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare\'s Workers Paid plan if you would like to continue usage.';

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,.;:!?、，。；：！？()（）/"'“”]+/u)
    .filter((word) => Array.from(word).length >= 2);
}

const SUSPICIOUS = ['verify your account', 'password expires', '账户异常', '立即验证', 'suspended'];
const NEEDS_ACTION = ['取件码', 'verification code', '验证码', 'payment due', 'please reply', 'deadline'];

export class FakeAi {
  /** The best option's probability (the decision's confidence). */
  confidence = 0.92;
  quota = false;
  /** Fail every call (a model outage) while set. */
  broken = false;
  readonly calls: ClefCall[] = [];
  /** Input tokens each Clef call reports. */
  tokensPerCall = 2000;
  /**
   * The probabilities a `choice` answers instead of the word match, from the option keys it was offered (the first
   * view's, or the second's fewer); null for the word match. They are completed to the options (the rest 0) and must
   * sum to 1.
   */
  choiceOverride: ((options: readonly string[]) => Record<string, number> | null) | null = null;

  reset(): void {
    this.confidence = 0.92;
    this.quota = false;
    this.broken = false;
    this.calls.length = 0;
    this.tokensPerCall = 2000;
    this.choiceOverride = null;
  }

  /** The binding's `run`: an answer, or a thrown Error with the message Workers AI gives. */
  run(model: string, input: Record<string, unknown>): Record<string, unknown> {
    this.calls.push({ model, input });
    if (this.quota) throw new Error(QUOTA_MESSAGE);
    if (this.broken) throw new Error('3043: internal server error');
    if (model === '@cf/baai/bge-m3') return this.embed(input);
    if (model === '@cf/cloudflare/clef' || model === '@cf/cloudflare/clef-flash') return this.clef(model, input);
    throw new Error('5007: no such model');
  }

  private clef(model: string, input: Record<string, unknown>): Record<string, unknown> {
    const state = (input['state'] ?? {}) as Record<string, unknown>;
    const questions = (input['questions'] ?? {}) as Record<string, { type: string; criteria?: Record<string, string> }>;
    const text = ['subject', 'snippet', 'body'].map((key) => (typeof state[key] === 'string' ? state[key] : '')).join(' ').toLowerCase();
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(questions)) {
      if (question.type === 'choice') {
        const options = Object.keys(question.criteria ?? {});
        const forced = this.choiceOverride?.(options) ?? null;
        if (forced !== null) {
          const probabilities = Object.fromEntries(options.map((option) => [option, forced[option] ?? 0]));
          const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none';
          answers[id] = { type: 'choice', choice: top, probabilities, confidence: probabilities[top] ?? 0 };
          continue;
        }
        const scores = options.map((option) => (option === 'none' ? 0 : words(question.criteria?.[option] ?? '').filter((word) => text.includes(word)).length));
        const best = Math.max(...scores);
        const top = best > 0 ? options[scores.indexOf(best)] ?? 'none' : 'none';
        const rest = (1 - this.confidence) / Math.max(1, options.length - 1);
        const probabilities = Object.fromEntries(options.map((option) => [option, option === top ? this.confidence : rest]));
        answers[id] = { type: 'choice', choice: top, probabilities, confidence: this.confidence };
      } else if (question.type === 'noul') {
        const phrases = id === 'suspicious' ? SUSPICIOUS : id === 'needs_action' ? NEEDS_ACTION : null;
        const yes = phrases !== null ? phrases.some((phrase) => text.includes(phrase)) : typeof state['list'] === 'string' && state['list'] !== '';
        answers[id] = { type: 'noul', noul: yes ? 0.9 : 0.05 };
      }
    }
    return { model: model === '@cf/cloudflare/clef-flash' ? 'clef-flash' : 'clef', answers, usage: { input_tokens: this.tokensPerCall, output_tokens: 0 } };
  }

  private embed(input: Record<string, unknown>): Record<string, unknown> {
    const texts = Array.isArray(input['text']) ? (input['text'] as string[]) : [];
    return { shape: [texts.length, 1024], data: texts.map((text) => embedText(text)) };
  }
}

/** A deterministic 1024-dimension unit vector of `text`'s character trigrams. */
export function embedText(text: string): number[] {
  const vector = new Array<number>(1024).fill(0);
  const chars = Array.from(text.toLowerCase());
  for (let i = 0; i + 3 <= chars.length; i++) {
    let hash = 2166136261;
    for (const char of chars.slice(i, i + 3).join('')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    vector[hash % 1024] = (vector[hash % 1024] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}
