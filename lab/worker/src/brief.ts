/**
 * The Chinese 简介 (docs/design.md §4 step 5): the prompt (title and abstract only) and the checks on the
 * model's answer, which is untrusted text. A refused answer is stored as null and the UI falls back to
 * the abstract's first sentences.
 */
import { BRIEF_MAX_CHARS } from './limits.ts';
import { clip, codePoints } from './arxiv.ts';

export const BRIEF_MAX_TOKENS = 300;
export const BRIEF_TEMPERATURE = 0.2;
/** Characters of the abstract given to the model (the feed's abstracts are ≤ 2,000 in practice). */
export const BRIEF_ABSTRACT_MAX = 2400;

export const BRIEF_SYSTEM =
  '你是论文摘要助手。用 2–4 句简体中文概括这篇论文做了什么、怎么做、结果如何；只使用摘要中的信息，不要推测，不要评价，不要列表，不要链接，不超过 180 字。只输出简介本身。';

export interface BriefMessages {
  readonly messages: readonly { readonly role: 'system' | 'user'; readonly content: string }[];
}

export function briefPrompt(title: string, abstract: string): BriefMessages {
  const cut = codePoints(abstract).slice(0, BRIEF_ABSTRACT_MAX).join('');
  return {
    messages: [
      { role: 'system', content: BRIEF_SYSTEM },
      { role: 'user', content: `标题：${title}\n\n摘要：${cut}` },
    ],
  };
}

/** The text of the prompt, for the neuron estimate. */
export function promptText(prompt: BriefMessages): string {
  return prompt.messages.map((m) => m.content).join('\n');
}

/** The generated text of a Workers AI text model answer (`response`, or OpenAI-style `choices`). */
export function generatedText(output: unknown): string | null {
  if (typeof output !== 'object' || output === null) return null;
  const response = (output as { response?: unknown }).response;
  if (typeof response === 'string') return response;
  const choices = (output as { choices?: unknown }).choices;
  if (Array.isArray(choices)) {
    const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
    if (typeof message?.content === 'string') return message.content;
  }
  return null;
}

export type BriefCheck = { readonly ok: true; readonly brief: string } | { readonly ok: false; readonly reason: 'empty' | 'no_cjk' | 'url' | 'too_many_sentences' };

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/** Cleans and checks the model's answer: plain text, Chinese, no URL, at most 6 sentences, ≤ 400 chars. */
export function checkBrief(raw: string): BriefCheck {
  // A reasoning model's <think> block is not part of the answer.
  let text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/<\/?think>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  text = text.replace(/^(?:简介|摘要|总结|概括)\s*[:：]\s*/, '').trim();
  text = text.replace(/^["“「『'](.*)["”」』']$/, '$1').trim();
  if (text === '') return { ok: false, reason: 'empty' };
  if (!CJK.test(text)) return { ok: false, reason: 'no_cjk' };
  if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|org|net|io|cn)\b/i.test(text)) return { ok: false, reason: 'url' };
  const sentences = text.split(/[。！？!?]/).filter((part) => part.trim() !== '');
  if (sentences.length > 6) return { ok: false, reason: 'too_many_sentences' };
  return { ok: true, brief: clip(text, BRIEF_MAX_CHARS) };
}

/** The first sentence of a 简介 (the Todoist subtask's description), at most `max` characters. */
export function firstSentence(brief: string, max = 120): string {
  const match = /^[^。！？!?]*[。！？!?]/.exec(brief);
  const sentence = (match?.[0] ?? brief).trim();
  return clip(sentence, max);
}
