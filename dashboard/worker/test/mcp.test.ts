import { describe, expect, it, vi } from 'vitest';
import type { ReadHomeResponse } from '@ziyixi/proto/dashboard/mcp/v1/home_service_wire';
import { HomeApi } from '../src/mcp.ts';
import type { Env } from '../src/env.ts';

const SNAPSHOT: ReadHomeResponse = {
  generated_at: '2026-10-01T12:00:00Z', build: 'synthetic', rev: 0,
  refresh: { last_tick_at: null, next_tick_at: '2026-10-01T12:30:00Z', last_refresh_at: null,
    next_refresh_at: '2026-10-01T12:00:00Z', refreshed: false },
  entries: [], attention: [], head_seq: 0, control_unavailable_count: 0,
};

describe('HomeApi service entrypoint', () => {
  it('forwards one cached read to the fixed HomeState object', async () => {
    const readHome = vi.fn().mockResolvedValue(SNAPSHOT);
    const idFromName = vi.fn().mockReturnValue('synthetic-home-v1');
    const get = vi.fn().mockReturnValue({ readHome });
    const entrypoint = new HomeApi({} as ExecutionContext, { HOME: { idFromName, get } } as unknown as Env);
    expect(await entrypoint.readHome({ after_occurrence_seq: 0 })).toEqual(SNAPSHOT);
    expect(idFromName).toHaveBeenCalledWith('home-v1');
    expect(readHome).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each([-1, 0.5, 2_147_483_648, undefined, '0'])('refuses invalid cursor %s before accessing storage', async value => {
    const entrypoint = new HomeApi({} as ExecutionContext, {} as Env);
    await expect(entrypoint.readHome({ after_occurrence_seq: value } as never)).rejects.toThrow('invalid_input');
  });
});
