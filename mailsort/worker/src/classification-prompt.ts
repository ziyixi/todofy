/** One optional meta override; reading bundled defaults never writes application state. */
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { ClassificationPromptSchema, type ClassificationPrompt } from '@ziyixi/proto/mailsort/ui/v2/prompt_pb';
import { newEtag } from './ids.ts';
import { PERSONAL_RULES, PRIORITY_PROMPT } from './priority-prompt.ts';
import type { Store } from './store.ts';

export const CLASSIFICATION_PROMPT_MAX_BYTES = 12 * 1024;
const META_KEY = 'classification_prompt';

export interface PromptValue {
  readonly baseText: string;
  readonly personalRules: string;
  readonly etag: string;
  readonly updateTime?: number;
}

export function readClassificationPrompt(store: Store): PromptValue {
  const saved = store.getMeta(META_KEY);
  return saved === null ? { baseText: PRIORITY_PROMPT, personalRules: PERSONAL_RULES, etag: 'initial' } : JSON.parse(saved) as PromptValue;
}

export function validClassificationPrompt(value: Pick<PromptValue, 'baseText' | 'personalRules'>): boolean {
  const encoder = new TextEncoder();
  return value.baseText.trim() !== '' && encoder.encode(value.baseText).byteLength + encoder.encode(value.personalRules).byteLength <= CLASSIFICATION_PROMPT_MAX_BYTES;
}

export function saveClassificationPrompt(store: Store, value: Pick<PromptValue, 'baseText' | 'personalRules'>, now: number): PromptValue {
  const saved = { ...value, etag: newEtag(now), updateTime: now };
  store.setMeta(META_KEY, JSON.stringify(saved));
  return saved;
}

export function classificationPromptMessage(value: PromptValue): ClassificationPrompt {
  return create(ClassificationPromptSchema, {
    name: 'classificationPrompt', baseText: value.baseText, personalRules: value.personalRules, etag: value.etag,
    ...(value.updateTime === undefined ? {} : { updateTime: timestampFromMs(value.updateTime) }),
  });
}
