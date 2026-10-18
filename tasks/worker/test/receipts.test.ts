import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { CreateTaskRequestSchema } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { fingerprint } from '../src/receipts.ts';

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
  expect(hash.legacy).not.toBe(hash.wire);
  const other = fromWire(CreateTaskRequestSchema, { request_id: requestId, task: { title: 'Other' } }).message;
  expect((await fingerprint('createTask', other)).wire).not.toBe(hash.wire);
});
