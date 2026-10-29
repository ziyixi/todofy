import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { CreateTaskRequestSchema } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { fingerprint, replay } from '../src/receipts.ts';

test('a field left at its default does not change the wire hash, so later fields keep old receipts valid', async () => {
  const requestId = randomUUID();
  const plain = fromWire(CreateTaskRequestSchema, { request_id: requestId, task: { title: 'Synthetic' } }).message;
  const explicit = fromWire(CreateTaskRequestSchema, {
    request_id: requestId,
    task: { title: 'Synthetic', kind: '', effort: '', description: '', label_ids: [] },
  }).message;
  // The wire form lists only the fields that are set: a field a later release adds is absent from it.
  expect(toWire(CreateTaskRequestSchema, plain)).toEqual({ task: { title: 'Synthetic' }, request_id: requestId });
  const hash = await fingerprint('createTask', plain);
  expect((await fingerprint('createTask', explicit)).wire).toBe(hash.wire);
  expect(await hash.legacy()).not.toBe(hash.wire);
  const other = fromWire(CreateTaskRequestSchema, { request_id: requestId, task: { title: 'Other' } }).message;
  expect((await fingerprint('createTask', other)).wire).not.toBe(hash.wire);
});

/** A D1 stand-in whose requests table answers `stored` for any request ID. */
function receiptStore(stored: { fingerprint: string; response: string } | null): D1Database {
  return { prepare: () => ({ bind: () => ({ first: () => Promise.resolve(stored) }) }) } as unknown as D1Database;
}

test('replay hashes the legacy form only for a stored receipt the wire hash does not match', async () => {
  const request = fromWire(CreateTaskRequestSchema, { request_id: randomUUID(), task: { title: 'Synthetic' } }).message;
  const hash = await fingerprint('createTask', request);
  const legacy = await hash.legacy();
  let computed = 0;
  const counted = {
    wire: hash.wire,
    legacy: () => {
      computed += 1;
      return hash.legacy();
    },
  };
  // A new request and a replay of a wire receipt never compute the legacy hash.
  expect(await replay(receiptStore(null), request.requestId, counted)).toBeNull();
  expect(await replay(receiptStore({ fingerprint: hash.wire, response: 'wire' }), request.requestId, counted)).toBe(
    'wire',
  );
  expect(computed).toBe(0);
  // A receipt stored before the wire form still replays; another input's receipt is refused.
  expect(await replay(receiptStore({ fingerprint: legacy, response: 'legacy' }), request.requestId, counted)).toBe(
    'legacy',
  );
  await expect(
    replay(receiptStore({ fingerprint: 'another input', response: 'other' }), request.requestId, counted),
  ).rejects.toThrow('Request ID was already used for different input');
  expect(computed).toBe(2);
});
