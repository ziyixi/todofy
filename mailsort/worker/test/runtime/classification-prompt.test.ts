/** Editable prompt state and cache hints through real SQLite/owner API, with synthetic requests only. */
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { ClassificationPromptSchema } from '@ziyixi/proto/mailsort/ui/v2/prompt_pb';
import { Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
const PRIORITY_PROMPT = readFileSync(new NodeURL('../../../prompts/priority-classification.txt', import.meta.url), 'utf8');
const PERSONAL_RULES = readFileSync(new NodeURL('../../../prompts/personal-rules.txt', import.meta.url), 'utf8');
import { MAX_BODY_BYTES } from '../../src/limits.ts';
import { MAILS } from '../fakes/fixtures.ts';
import { HOUR, MINUTE, op, ORIGIN, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';
import { checkGoogleCalls, deliver, setMode } from './helpers.ts';

let h: Harness;
afterEach(async () => { checkGoogleCalls(h); await h.dispose(); });
const get = () => h.api.getClassificationPrompt({ name: 'classificationPrompt' });
async function save(baseText: string, personalRules: string, etag = 'initial', requestId = op()) {
  return h.api.updateClassificationPrompt({ classificationPrompt: create(ClassificationPromptSchema, { name: 'classificationPrompt', baseText, personalRules, etag }), updateMask: { paths: ['base_text', 'personal_rules', 'etag'] }, requestId });
}
async function ready() {
  h = await startHarness();
  await h.step(T0);
  await setMode(h, Mode.LIVE);
  await h.api.initializePriorities({ requestId: op() });
}
const input = (id: number) => ({ ...MAILS.bankEn, id: `abc${id.toString(16).padStart(13, '0')}` });

it('reads defaults without persisting and saves both texts while off, with request replay and stale-etag checks', async () => {
  h = await startHarness();
  await setMode(h, Mode.OFF);
  const initial = await get();
  expect(initial).toMatchObject({ baseText: PRIORITY_PROMPT, personalRules: PERSONAL_RULES, etag: 'initial' });
  expect(initial.updateTime).toBeUndefined();
  expect(await h.sql(`SELECT value FROM meta WHERE key = 'classification_prompt'`)).toEqual([]);
  const requestId = op();
  const saved = await save('Synthetic base', '', 'initial', requestId);
  expect(saved).toMatchObject({ baseText: 'Synthetic base', personalRules: '' });
  expect(saved.etag).not.toBe('initial');
  expect(saved.updateTime).toBeDefined();
  expect(await save('Different retry input', 'ignored', 'initial', requestId)).toEqual(saved);
  expect(reasonOf(await rejection(save('Stale', 'rules')))).toBe('ETAG_MISMATCH');
  expect(await get()).toEqual(saved);
  expect(h.up.gmail.calls).toEqual([]);
  expect(h.up.claude.calls).toEqual([]);
});

it('validates UTF-8 size and masks, accepts escaped prompt bodies above16KiB, and keeps owner/CSRF boundaries', async () => {
  h = await startHarness();
  expect(reasonOf(await rejection(save(' ', 'rules')))).toBe('BAD_REQUEST');
  expect(reasonOf(await rejection(save('中'.repeat(4097), '')))).toBe('BAD_REQUEST');
  const noMask = h.api.updateClassificationPrompt({ classificationPrompt: create(ClassificationPromptSchema, { name: 'classificationPrompt', baseText: 'Synthetic base' }), requestId: op() });
  expect(reasonOf(await rejection(noMask))).toBe('BAD_REQUEST');
  const largeEscaped = '"'.repeat(10000);
  expect(new TextEncoder().encode(JSON.stringify({ base_text: largeEscaped })).length).toBeGreaterThan(16 * 1024);
  expect((await save(largeEscaped, '')).baseText).toBe(largeEscaped);
  const csrf = await h.fetch('/api/v2/classificationPrompt?update_mask=base_text', { method: 'PATCH', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
  expect(csrf.status).toBe(403);
  const outside = await h.fetch('/api/v2/classificationPrompt', { headers: { 'cf-ray': 'synthetic' } });
  expect(outside.status).toBeGreaterThanOrEqual(400);
  const tooLarge = await h.mutate('PATCH', '/api/v2/classificationPrompt?update_mask=base_text', { name: 'classificationPrompt', base_text: 'x'.repeat(MAX_BODY_BYTES) });
  expect(tooLarge.status).toBe(400);
});

it('uses saved prompt text on the next request without rejudging prior mail and leaves hourly single batches uncached', async () => {
  await ready();
  deliver(h, input(1), T0 + MINUTE);
  await h.step(T0 + 2 * MINUTE);
  expect(h.up.claude.systems[0]?.map(block => block.text)).toEqual([PRIORITY_PROMPT, PERSONAL_RULES]);
  expect(h.up.claude.systems[0]?.every(block => block.cache_control === undefined)).toBe(true);
  await save('New synthetic base', 'New synthetic rules');
  deliver(h, input(2), T0 + HOUR);
  await h.step(T0 + HOUR + 2 * MINUTE);
  expect(h.up.claude.systems[1]?.map(block => block.text)).toEqual(['New synthetic base', 'New synthetic rules']);
  expect(h.up.claude.systems[1]?.every(block => block.cache_control === undefined)).toBe(true);
  expect(h.up.claude.calls.flat().map(email => email.id)).toEqual([input(1).id, input(2).id]);
});

it('caches a backlog and its recent tail, recording actual cache writes/reads within total input and cost', async () => {
  await ready();
  h.up.claude.cacheWriteTokens = 6000;
  for (let id = 1; id <= 11; id++) deliver(h, input(id), T0 + MINUTE);
  await h.step(T0 + 2 * MINUTE);
  expect(h.up.claude.calls[0]).toHaveLength(10);
  expect(h.up.claude.systems[0]?.every(block => block.cache_control?.ttl === '5m')).toBe(true);
  expect(await h.sql(`SELECT value FROM meta WHERE key = 'claude_prompt_cache_at'`)).toEqual([{ value: String(T0 + 2 * MINUTE) }]);
  h.up.claude.cacheWriteTokens = 0;
  h.up.claude.cacheReadTokens = 6000;
  await h.step(T0 + 3 * MINUTE);
  expect(h.up.claude.calls[1]).toHaveLength(1);
  expect(h.up.claude.systems[1]?.every(block => block.cache_control?.ttl === '5m')).toBe(true);
  expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).claudeBudget).toMatchObject({ inputTokens: 14400, cacheWriteTokens: 6000, cacheReadTokens: 6000, outputTokens: 240, spentUsd: 0.0456 });
  expect((await h.opsStatus())['counters']).toMatchObject({ claude_cache_write_tokens: 6000, claude_cache_read_tokens: 6000 });
  h.up.claude.cacheReadTokens = 0;
  deliver(h, input(12), T0 + HOUR + 3 * MINUTE);
  await h.step(T0 + HOUR + 3 * MINUTE);
  expect(h.up.claude.systems[2]?.every(block => block.cache_control === undefined)).toBe(true);
});

it('records billed cache usage and the request-start marker even when a batch answer is invalid', async () => {
  await ready();
  h.up.claude.cacheWriteTokens = 6000;
  h.up.claude.badItems = true;
  for (let id = 1; id <= 11; id++) deliver(h, input(id), T0 + MINUTE);
  expect(await h.step(T0 + 2 * MINUTE)).toMatchObject({ code: 'claude_bad_items', decided: 0 });
  expect(await h.sql(`SELECT value FROM meta WHERE key = 'claude_prompt_cache_at'`)).toEqual([{ value: String(T0 + 2 * MINUTE) }]);
  expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).claudeBudget).toMatchObject({ cacheWriteTokens: 6000, spentUsd: 0.0372 });
});
