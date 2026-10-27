/**
 * The writer's requests (../../docs/design.md §7, §9, §13): policy.md and profile.md as the frozen prefix every writer
 * call shares, with its one cache breakpoint; the call's own rules after it; the efforts, limits and structured outputs;
 * no thinking parameter, sampling parameter or prefill; no link in what the writer reads; the reservation's estimate.
 * Synthetic packets only.
 */
import type { Instruction } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { describe, expect, it } from 'vitest';
import { DEEP_WRITE_MAX_TOKENS, REPAIR_MAX_TOKENS, WRITE_MAX_TOKENS } from '../src/limits.ts';
import { estimateTokens } from '../src/prices.ts';
import {
  DEEP_WRITE_SCHEMA,
  deepPickRequest,
  deepWriteRequest,
  entailRequest,
  gateRequest,
  pickRequest,
  repairRequest,
  WRITE_SCHEMA,
  WRITER_PREFIX,
  writeRequest,
  type Params,
  type WriterPacket,
} from '../src/prompts.ts';
import { bundled, POLICY_TEXT, PROFILE_TEXT } from '../src/registry.ts';

const DATE = '2026-10-12';

const PACKET: WriterPacket = {
  id: 'p1',
  section: 'research',
  topic: 'llm.systems',
  format: 'familiar',
  heldBack: null,
  signals: [],
  documents: [
    {
      doc: 'd1',
      source: 'synthetic-preprints',
      venue: 'Synthetic Preprints',
      review: 'preprint',
      scope: 'full_text',
      title: 'Speculative decoding at long context',
      published: Date.parse('2026-10-09T00:00:00Z'),
      uri: 'https://papers.synthetic-preprints.org/abs/2610.00001',
      text: 'Beyond 32K tokens the time saved by drafting is offset by cache reads. Sharing the cache recovers the speedup.',
    },
  ],
};

const ITEM = { packet: 'p1', section: 'research', title: '标题', paragraphs: [{ heading: '', text: '正文[1]。' }], why: '一句。', claims: [{ n: 1, doc: 'd1', quote: 'Sharing the cache recovers the speedup.' }] };

const writers: [string, () => { params: Params; estimatedInputTokens: number }, string, number, Record<string, unknown>][] = [
  ['write', () => writeRequest(DATE, [PACKET]), '# 输出规则\n', WRITE_MAX_TOKENS, WRITE_SCHEMA],
  ['repair', () => repairRequest(DATE, [{ packet: PACKET, item: ITEM, problems: ['quote_not_found: …'] }]), '# 输出规则\n', REPAIR_MAX_TOKENS, WRITE_SCHEMA],
  ['deep read', () => deepWriteRequest('2026-10-17', { title: '主题', angle: '角度', ids: ['c1'], reason: '' }, PACKET), '# 输出规则（深读）\n', DEEP_WRITE_MAX_TOKENS, DEEP_WRITE_SCHEMA],
  ['deep repair', () => repairRequest('2026-10-17', [{ packet: PACKET, item: { ...ITEM, section: 'deep_read', why: '' }, problems: ['length: 1100'] }], true), '# 输出规则（深读）\n', REPAIR_MAX_TOKENS, DEEP_WRITE_SCHEMA],
];

function userText(params: Params): string { return params.input; }
function system(params: Params): Instruction[] { return params.instructions; }

describe('the writer', () => {
  it('starts every call with policy.md then profile.md, frozen, with the one cache breakpoint at its end', () => {
    expect(WRITER_PREFIX.startsWith(POLICY_TEXT.trim())).toBe(true);
    expect(WRITER_PREFIX.endsWith(PROFILE_TEXT.trim())).toBe(true);
    // Above Opus 5.5's minimum cacheable prefix (512 tokens), or the breakpoint would be silently ignored.
    expect(estimateTokens(WRITER_PREFIX)).toBeGreaterThan(2 * 512);
    for (const [name, build, rules] of writers) {
      const { params } = build();
      const [prefix, own, ...rest] = system(params);
      expect(prefix, name).toEqual(expect.objectContaining({ text: WRITER_PREFIX, cache: true }));
      expect(own?.text.startsWith(rules), name).toBe(true);
      expect(own?.cache, name).toBe(false);
      expect(rest, name).toEqual([]);
      // One breakpoint in the whole request, and nothing of the day before it.
      expect(params.instructions.filter(block => block.cache), name).toHaveLength(1);
      expect(JSON.stringify(system(params)), name).not.toMatch(/20\d\d-\d\d-\d\d|synthetic-preprints|Speculative/);
    }
    expect(system(repairRequest(DATE, [], false).params)[1]?.text).toContain('# 修订');
    expect(system(repairRequest(DATE, [], true).params)[1]?.text).toContain('# 修订');
  });

  it('asks for high effort, its limit and its schema; no thinking or sampling parameter; one user turn, no prefill', () => {
    for (const [name, build, , maxTokens, schema] of writers) {
      const { params } = build();
      expect(params.parameters.maxOutputTokens, name).toBe(maxTokens);
      expect(params.parameters, name).toMatchObject({ effort: 'high', allowFallback: true });
      expect(JSON.parse(params.outputSchemaJson), name).toEqual(schema);
      for (const key of ['thinking', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'cache_control']) expect(params, `${name}: ${key}`).not.toHaveProperty(key);
      expect(userText(params), name).toMatch(/^日期：2026-10-1\d\n/);
    }
  });

  it('keeps every object of its schemas closed, as structured outputs require', () => {
    const closed = (schema: unknown): boolean => {
      if (typeof schema !== 'object' || schema === null) return true;
      const node = schema as Record<string, unknown>;
      if (node['type'] === 'object' && node['additionalProperties'] !== false) return false;
      return Object.values(node).every(closed);
    };
    expect(closed(WRITE_SCHEMA)).toBe(true);
    expect(closed(DEEP_WRITE_SCHEMA)).toBe(true);
  });

  it('names every key of the packets it is given, and only those', () => {
    const keys = ['packet', 'section', 'topic', 'format', 'held_back', 'documents', 'signals', 'doc', 'venue', 'review', 'text_scope', 'title', 'published', 'text'];
    for (const [name, build] of writers) {
      const rules = system(build().params)[1]?.text ?? '';
      for (const key of keys) expect(rules, `${name}: ${key}`).toContain(key);
    }
    // The keys the rules name are the keys packetJson writes (held_back only when the packet was held back).
    const held: WriterPacket = { ...PACKET, heldBack: 'An earlier synthetic title', signals: ['A synthetic headline'] };
    const user = userText(writeRequest(DATE, [held]).params);
    const [packet] = JSON.parse(user.slice(user.indexOf('['))) as Record<string, unknown>[];
    expect(Object.keys(packet ?? {}).sort()).toEqual(['documents', 'format', 'held_back', 'packet', 'section', 'signals', 'topic']);
    const [document] = (packet?.['documents'] ?? []) as Record<string, unknown>[];
    expect(Object.keys(document ?? {}).sort()).toEqual(['doc', 'published', 'review', 'text', 'text_scope', 'title', 'venue']);
  });

  it('gives the writer no link: the source line and its links are code', () => {
    for (const [name, build] of writers) expect(userText(build().params), name).not.toMatch(/https?:\/\/|"uri"/);
    expect(userText(writeRequest(DATE, [PACKET]).params)).toContain('"published":"2026-10-09"');
  });

  it('reserves the cached prefix at the cache-write premium', () => {
    const { params, estimatedInputTokens } = writeRequest(DATE, [PACKET]);
    const [prefix, own] = system(params);
    expect(estimatedInputTokens).toBe(Math.ceil(estimateTokens(prefix?.text ?? '') * 1.25) + estimateTokens(own?.text ?? '') + estimateTokens(userText(params)));
  });
});

describe('the other calls', () => {
  it('keep their efforts: the gate and the log low, the picks medium', () => {
    const { topics } = bundled();
    expect(gateRequest([{ id: 'c1', section: 'research', venue: 'V', review: 'preprint', title: 't', summary: 's', otherVenues: [] }], topics).params.parameters.effort).toBe('low');
    expect(entailRequest([{ item: 'r1', n: 1, quote: 'q', sentences: ['s'] }]).params.parameters.effort).toBe('low');
    expect(pickRequest(DATE, [], [], {}).params.parameters.effort).toBe('medium');
    expect(deepPickRequest('2026-10-17', [], []).params.parameters.effort).toBe('medium');
  });
});
