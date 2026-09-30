/** Ranking maths, the neuron arithmetic and the 简介 checks (docs/design.md §4–§5). */
import { describe, expect, it } from 'vitest';
import { briefPrompt, checkBrief, firstSentence, generatedText, promptText } from '../src/brief.ts';
import { effectiveCap, embedEstimate, fits, isAllowanceError, neuronsFor, reportedUsage, textEstimate, tokenBound } from '../src/neurons.ts';
import { centroid, dot, explore, fromBlob, normalize, positiveCentroids, rank, toBlob, type Vector } from '../src/vectors.ts';

const D = 8;
function vec(...values: number[]): Vector {
  const padded = [...values, ...new Array<number>(D - values.length).fill(0)];
  const v = normalize(padded, D);
  if (v === null) throw new Error('zero vector');
  return v;
}

describe('vectors', () => {
  it('normalises, refuses bad input and round-trips through a BLOB', () => {
    const v = vec(3, 4);
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
    expect(normalize([0, 0], 2)).toBeNull();
    expect(normalize([1, Number.NaN], 2)).toBeNull();
    expect(normalize([1, 2, 3], 2)).toBeNull();
    const back = fromBlob(toBlob(v), D);
    expect(back && Array.from(back)).toEqual(Array.from(v));
    expect(fromBlob(new ArrayBuffer(12), D)).toBeNull();
    expect(fromBlob(new Uint8Array(toBlob(v)), D)).not.toBeNull();
  });

  it('keeps up to 16 positives as they are and clusters more deterministically', () => {
    const few = [vec(1), vec(0, 1)];
    expect(positiveCentroids(few, 16)).toEqual(few);
    const many = Array.from({ length: 40 }, (_, i) => vec(i % 2 === 0 ? 1 : 0, i % 2 === 1 ? 1 : 0, (i % 5) / 10));
    const a = positiveCentroids(many, 4);
    const b = positiveCentroids(many, 4);
    expect(a).toHaveLength(4);
    expect(a.map((c) => Array.from(c))).toEqual(b.map((c) => Array.from(c)));
    for (const c of a) expect(dot(c, c)).toBeCloseTo(1, 5);
  });

  it('ranks by the nearest positive minus λ times the negative centroid, and names the nearest positive', () => {
    const positives = [
      { paper_id: 'arxiv:seed.retrieval', vector: vec(1, 0, 0) },
      { paper_id: 'arxiv:like.vision', vector: vec(0, 1, 0) },
    ];
    const candidates = [
      { paper_id: 'arxiv:c1', vector: vec(1, 0.1, 0) },
      { paper_id: 'arxiv:c2', vector: vec(0.1, 1, 0) },
      { paper_id: 'arxiv:c3', vector: vec(0, 0, 1) },
    ];
    const plain = rank({ candidates, positives, negative: null, lambda: 0.3, size: 20 });
    expect(plain.map((p) => p.paper_id)).toEqual(['arxiv:c1', 'arxiv:c2', 'arxiv:c3']);
    expect(plain.map((p) => p.because_id)).toEqual(['arxiv:seed.retrieval', 'arxiv:like.vision', 'arxiv:seed.retrieval']);
    // Disliking vision-like papers pushes c2 below c1 by more, and a strong λ below the unrelated c3.
    const negative = centroid([vec(0.1, 1, 0)]);
    const shifted = rank({ candidates, positives, negative, lambda: 1, size: 2 });
    expect(shifted.map((p) => p.paper_id)).toEqual(['arxiv:c1', 'arxiv:c3']);
    expect(rank({ candidates, positives: [], negative: null, lambda: 0.3, size: 20 })).toEqual([]);
  });

  it('builds the cold-start deck round-robin over primary categories in feed order', () => {
    const items = [
      { paper_id: 'a1', primary_category: 'cs.IR' },
      { paper_id: 'a2', primary_category: 'cs.IR' },
      { paper_id: 'a3', primary_category: 'cs.IR' },
      { paper_id: 'b1', primary_category: 'cs.CL' },
      { paper_id: 'c1', primary_category: 'cs.LG' },
      { paper_id: 'b2', primary_category: 'cs.CL' },
    ];
    expect(explore(items, 5).map((i) => i.paper_id)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2']);
    expect(explore(items, 20)).toHaveLength(6);
  });
});

describe('neurons', () => {
  it('prices an upper bound of tokens with the table rates', () => {
    expect(tokenBound('abc')).toBe(1);
    expect(tokenBound('abcd')).toBe(2);
    expect(tokenBound('中文')).toBe(2);
    expect(neuronsFor('@cf/baai/bge-m3', 1_000_000, 0)).toBe(1075);
    // 1.542 + 3.0474 = 4.5894, rounded up to 1/1000.
    expect(neuronsFor('@cf/ibm-granite/granite-4.0-h-micro', 1000, 300)).toBe(4.59);
    expect(embedEstimate('@cf/baai/bge-m3', ['a'.repeat(3000), 'b'.repeat(3000)])).toBeCloseTo(2.15, 3);
    const prompt = promptText(briefPrompt('T', 'x'.repeat(2100)));
    expect(textEstimate('@cf/ibm-granite/granite-4.0-h-micro', prompt, 300)).toBeGreaterThan(neuronsFor('@cf/ibm-granite/granite-4.0-h-micro', 700, 300));
  });

  it('never lets the owner raise the cap above the ceiling', () => {
    expect(effectiveCap(5000, null)).toBe(5000);
    expect(effectiveCap(5000, 1500)).toBe(1500);
    expect(effectiveCap(5000, 9000)).toBe(5000);
    expect(effectiveCap(5000, -3)).toBe(0);
    expect(fits(4990, 10, 5000)).toBe(true);
    expect(fits(4990, 10.001, 5000)).toBe(false);
  });

  it('recognises the account allowance error and reported usage', () => {
    expect(isAllowanceError(new Error('3036: Account limit of 10000 daily neurons exceeded'))).toBe(true);
    expect(isAllowanceError(new Error('4006: you have used up your daily free allocation'))).toBe(true);
    expect(isAllowanceError(new Error('InferenceUpstreamError: timeout'))).toBe(false);
    expect(reportedUsage({ response: 'x', usage: { prompt_tokens: 700, completion_tokens: 120, total_tokens: 820 } })).toEqual({ input: 700, output: 120 });
    expect(reportedUsage({ response: 'x' })).toBeNull();
    expect(reportedUsage({ usage: { prompt_tokens: -1, completion_tokens: 2 } })).toBeNull();
  });
});

describe('简介', () => {
  it('prompts with the title and abstract only', () => {
    const prompt = briefPrompt('Dense Retrieval', 'We propose X.');
    expect(prompt.messages).toHaveLength(2);
    expect(prompt.messages[0]?.content).toContain('只使用摘要中的信息');
    expect(prompt.messages[1]?.content).toBe('标题：Dense Retrieval\n\n摘要：We propose X.');
  });

  it('reads both answer shapes', () => {
    expect(generatedText({ response: '好' })).toBe('好');
    expect(generatedText({ choices: [{ message: { content: '好' } }] })).toBe('好');
    expect(generatedText({ result: 'x' })).toBeNull();
  });

  it('cleans the answer and refuses what is not a short Chinese summary', () => {
    expect(checkBrief('简介：本文提出一种检索方法。实验表明召回率提升。')).toEqual({ ok: true, brief: '本文提出一种检索方法。实验表明召回率提升。' });
    expect(checkBrief('“本文研究稠密检索。”')).toEqual({ ok: true, brief: '本文研究稠密检索。' });
    expect(checkBrief('<think>hmm</think>本文\u0007研究检索。')).toEqual({ ok: true, brief: '本文 研究检索。' });
    expect(checkBrief('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(checkBrief('This paper proposes a retrieval method.')).toEqual({ ok: false, reason: 'no_cjk' });
    expect(checkBrief('详见 https://evil.example.com 获取代码。')).toEqual({ ok: false, reason: 'url' });
    expect(checkBrief('一。二。三。四。五。六。七。')).toEqual({ ok: false, reason: 'too_many_sentences' });
    const long = checkBrief('长'.repeat(500));
    expect(long.ok && Array.from(long.brief).length).toBe(400);
  });

  it('takes the first sentence for the Todoist subtask', () => {
    expect(firstSentence('本文提出一种方法。结果很好。')).toBe('本文提出一种方法。');
    expect(firstSentence('没有句号的一句话')).toBe('没有句号的一句话');
    expect(Array.from(firstSentence(`${'长'.repeat(200)}。`)).length).toBe(120);
  });
});
