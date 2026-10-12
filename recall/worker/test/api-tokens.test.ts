// Two matching requests can overlap while WebCrypto hashes their independently generated tokens.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { CreateMachineTokenRequestSchema, RegenerateMachineTokenRequestSchema } from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb';
import { handlers, type ApiContext } from '../src/api.ts';
import { heldDigests, namedTokens, tokenDigest } from '../src/tokens.ts';
import { memoryStore } from './sqlite.ts';

const NOW = Date.parse('2026-10-12T02:00:00Z');

describe('overlapping token requests', () => {
  it.each(['named', 'legacy'] as const)('shows only the stored %s token when the same request overlaps', async (kind) => {
    const store = memoryStore();
    const context = { store, now: NOW, transact: <T>(run: () => T): T => run(), secretTokens: { ingest: false, export: false } } as ApiContext;
    const release: (() => void)[] = [];
    const hashing = vi.spyOn(crypto.subtle, 'digest').mockImplementation((_algorithm, bytes) => {
      const input = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
      const digest = Uint8Array.from(createHash('sha256').update(input).digest()).buffer;
      return new Promise<ArrayBuffer>((resolve) => { release.push(() => { resolve(digest); }); });
    });
    const requestId = crypto.randomUUID();
    const start = kind === 'named'
      ? () => handlers.createMachineToken(create(CreateMachineTokenRequestSchema, { machineToken: { label: 'Phone' }, requestId }), context)
      : () => handlers.regenerateMachineToken(create(RegenerateMachineTokenRequestSchema, { name: 'machineTokens/ingest', requestId }), context);
    const first = start();
    const second = start();
    expect(release).toHaveLength(2);
    release.shift()?.();
    const winner = await first;
    release.shift()?.();
    const replay = await second;
    hashing.mockRestore();
    if (!('token' in winner)) throw new Error('expected a token resource');
    expect(winner.token).toMatch(/^recall_ingest_[A-Za-z0-9_-]{43}$/);
    expect(replay).toMatchObject({ name: winner.name, token: '' });
    expect(heldDigests(store, NOW).ingest).toContain(await tokenDigest(winner.token));
    expect(namedTokens(store)).toHaveLength(kind === 'named' ? 1 : 0);
    expect(JSON.stringify(store.all(`SELECT * FROM requests`))).not.toContain(winner.token);
  });
});
