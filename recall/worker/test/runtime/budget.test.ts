// The daily write budget's arithmetic, measured in workerd (../../../docs/design.md §4, §5.3): the rows written by a new
// visit, a visit revision, a kept text of 32 KiB of Chinese (with its FTS5 insert) and a heartbeat, and the expected
// day (about 600 revisions, 60 texts and 300 uploads) against DAILY_ROW_BUDGET. Local workerd counts one row per FTS5
// insert; production may count every segment page FTS5 writes, which the first production day measures.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAILY_ROW_BUDGET } from '../../src/limits.ts';
import { batch, document, uuid, visit } from './data.ts';
import { MINUTE, startHarness, T0, type Harness } from './harness.ts';

/** About `bytes` bytes of synthetic Chinese text. */
function chinese(bytes: number): string {
  const sentence = '这是一段为测试写的中文正文，讲的是持久对象、全文检索和二元分词的索引大小。';
  return sentence.repeat(Math.ceil(bytes / new TextEncoder().encode(sentence).byteLength)).slice(0, Math.floor(bytes / 3));
}

describe('rows written', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });

  it('per new visit, per revision, per 32 KiB text and per heartbeat, within the budget on an expected day', async () => {
    const written = async (items: unknown[]) => {
      await h.rows();
      const response = await h.upload(batch(items));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ rejected: [] });
      return (await h.rows()).written;
    };
    const url = 'https://reader.example.com/articles/1';
    const spans = (minutes: number): [number, number][] => [[T0 - 20 * MINUTE, T0 - (20 - minutes) * MINUTE]];
    const newVisit = await written([await visit({ id: uuid(1), url, title: '文章', spans: spans(1) })]);
    const revision = await written([await visit({ id: uuid(1), url, title: '文章', revision: 2, spans: spans(2) })]);
    const secondRevision = await written([await visit({ id: uuid(1), url, title: '文章', revision: 3, spans: spans(3) })]);
    const text = await written([await document({ id: uuid(2), visitId: uuid(1), url, captureMs: T0 - 17 * MINUTE, text: chinese(32 * 1024) })]);
    const heartbeat = await written([]);
    // Ten revisions of ten visits of one site in one upload: the cost of a revision without its upload's own rows.
    const others = await Promise.all(Array.from({ length: 10 }, (_, i) => visit({ id: uuid(10 + i), url: `https://reader.example.com/articles/${String(10 + i)}`, spans: spans(1) })));
    await written(others);
    const revisions = await Promise.all(Array.from({ length: 10 }, (_, i) => visit({ id: uuid(10 + i), url: `https://reader.example.com/articles/${String(10 + i)}`, revision: 2, spans: spans(2) })));
    const perRevision = (await written(revisions)) / 10;
    const day = 600 * perRevision + 60 * text + 300 * heartbeat;
    console.log(
      `rows written: new visit ${String(newVisit)}, revision ${String(revision)}/${String(secondRevision)} alone and ${String(perRevision)} in a batch of ten, ` +
        `32 KiB text ${String(text)}, heartbeat ${String(heartbeat)}; expected day ${String(day)} of ${String(DAILY_ROW_BUDGET)}`,
    );
    expect(perRevision).toBeLessThanOrEqual(7);
    expect(revision).toBeLessThanOrEqual(10);
    expect(newVisit).toBeLessThanOrEqual(25);
    expect(text).toBeLessThanOrEqual(20);
    expect(heartbeat).toBeLessThanOrEqual(3);
    expect(day).toBeLessThan(DAILY_ROW_BUDGET / 2);
    // The counter the budget reads holds every row, its own writes included.
    const [usage] = await h.sql<{ rows_written: number }>(`SELECT rows_written FROM usage`);
    expect(usage?.rows_written).toBeGreaterThanOrEqual(newVisit + revision + secondRevision + text);
  });
});
