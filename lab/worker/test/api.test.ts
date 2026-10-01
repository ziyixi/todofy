/**
 * The owner API's mapping (src/api.ts): reasons against errors.proto and the transcoder, resource IDs of
 * old-style arXiv IDs, and the internal records as lab.ui.v1 messages in the wire JSON profile.
 */
import { describe, expect, it } from 'vitest';
import { ErrorReason } from '@ziyixi/proto/lab/ui/v1/errors_pb';
import { DeckStateSchema, SendSchema } from '@ziyixi/proto/lab/ui/v1/deck_pb';
import { TRANSCODER_REASONS } from '@ziyixi/proto/http-transcoder';
import { HTTP_STATUS, codeName } from '@ziyixi/proto/rpc-status';
import { toWire } from '@ziyixi/proto/wire-json';
import { deckStateMessage, REASONS, resourceIdOf, sendMessage } from '../src/api.ts';

describe('reasons', () => {
  it('cover every ErrorReason and every reason of the transcoder but INTERNAL (Lab answers UNAVAILABLE)', () => {
    const declared = Object.keys(ErrorReason).filter((name) => name !== 'UNSPECIFIED');
    expect(Object.keys(REASONS).sort()).toEqual(declared.sort());
    for (const reason of Object.values(TRANSCODER_REASONS).filter((r) => r !== 'INTERNAL')) expect(REASONS).toHaveProperty(reason);
  });

  it('keep the HTTP statuses errors.proto documents', () => {
    const http = Object.fromEntries(Object.entries(REASONS).map(([reason, { code }]) => [reason, HTTP_STATUS[codeName(code)]]));
    expect(http).toMatchObject({ UNAUTHORIZED: 401, CSRF_FAILED: 403, BAD_REQUEST: 400, DECK_NOT_FOUND: 404, DECK_CHANGED: 409, ALREADY_DECIDED: 409, NOTHING_TO_UNDO: 400, UNAVAILABLE: 503, ALREADY_LIKED: 409 });
  });
});

describe('resource IDs', () => {
  it('are the bare arXiv ID, with an old-style ID’s slash written as ~', () => {
    expect(resourceIdOf('arxiv:2609.35773')).toBe('2609.35773');
    expect(resourceIdOf('arxiv:hep-th/9901001')).toBe('hep-th~9901001');
  });
});

describe('records as messages', () => {
  it('writes a deck state in the wire profile (snake_case, enum names, RFC 3339, defaults omitted)', () => {
    const state = deckStateMessage({
      deck_id: '2026-09-30',
      version: 3,
      decisions: { 'arxiv:2609.00002': 'dislike', 'arxiv:2609.00001': 'like' },
      counts: { total: 20, decided: 2, liked: 1, disliked: 1 },
      next_position: 3,
      finished_at: null,
      undo: { kind: 'decide', paper_id: 'arxiv:2609.00002', decision: 'dislike' },
    });
    expect(JSON.stringify(toWire(DeckStateSchema, state))).toBe(
      JSON.stringify({
        deck: 'decks/2026-09-30',
        version: 3,
        decisions: { 'arxiv:2609.00001': 'like', 'arxiv:2609.00002': 'dislike' },
        counts: { total: 20, decided: 2, liked: 1, disliked: 1 },
        next_position: 3,
        undo: { kind: 'decide', paper_id: 'arxiv:2609.00002', decision: 'dislike' },
      }),
    );
  });

  it('maps a send with Lab’s own error code', () => {
    const send = sendMessage('2026-09-30', {
      generation: 1,
      intent_id: 'deck-2026-09-30-g1',
      mode: 'separate',
      state: 'unknown',
      recorded: false,
      items: 2,
      tasks_total: 0,
      tasks_created: 0,
      error_code: 'busy',
      frozen: true,
      poll_after: '2026-09-30T14:03:07.250Z',
      updated_at: '2026-09-30T14:03:04Z',
    });
    expect(toWire(SendSchema, send)).toEqual({
      name: 'decks/2026-09-30/send',
      generation: 1,
      intent_id: 'deck-2026-09-30-g1',
      mode: 'separate',
      state: 'unknown',
      item_count: 2,
      error_code: 'busy',
      frozen: true,
      next_poll_time: '2026-09-30T14:03:07.250Z',
      update_time: '2026-09-30T14:03:04Z',
    });
  });
});
