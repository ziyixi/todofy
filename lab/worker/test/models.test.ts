import { describe, expect, it } from 'vitest';
import { DEFAULT_TLDR_MODEL, EMBED_MODEL, MODEL_RATES, TLDR_MODELS } from '../src/models.ts';

describe('model allow-list', () => {
  it('prices every model Lab may call', () => {
    expect(MODEL_RATES[EMBED_MODEL].kind).toBe('embedding');
    expect(TLDR_MODELS).toContain(DEFAULT_TLDR_MODEL);
    for (const id of TLDR_MODELS) expect(MODEL_RATES[id].kind).toBe('text');
  });
});
