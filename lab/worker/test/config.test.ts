/** Vars, settings and input validation (docs/design.md §3, §6, §8). */
import { describe, expect, it } from 'vitest';
import { addDays, fetchHour, isDay, iso, neuronCeiling, nextFetchSlot, publicHost } from '../src/config.ts';
import { decodeCursor, encodeCursor, likePattern, settingsFrom } from '../src/db.ts';
import type { Env } from '../src/env.ts';
import { HttpError, parseSettings } from '../src/http.ts';

const env = (vars: Partial<Record<keyof Env, string>>) => vars as unknown as Env;

describe('vars', () => {
  it('reads the neuron ceiling fail-safe', () => {
    expect(neuronCeiling(env({ LAB_DAILY_NEURONS: '5000' }))).toBe(5000);
    expect(neuronCeiling(env({ LAB_DAILY_NEURONS: '10000' }))).toBe(10000);
    for (const bad of ['10001', '-1', '5e3', '', ' ', 'abc']) expect(neuronCeiling(env({ LAB_DAILY_NEURONS: bad })), bad).toBe(0);
    expect(neuronCeiling(env({}))).toBe(0);
  });

  it('reads the fetch hour and the host', () => {
    expect(fetchHour(env({ LAB_FETCH_UTC_HOUR: '6' }))).toBe(6);
    expect(fetchHour(env({ LAB_FETCH_UTC_HOUR: '24' }))).toBe(6);
    expect(publicHost(env({ PUBLIC_HOST: 'Lab.Example.com' }))).toBe('lab.example.com');
    expect(publicHost(env({ PUBLIC_HOST: 'lab.example.com/evil' }))).toBeNull();
  });

  it('schedules the daily fetch at hour:30 UTC', () => {
    const at = Date.parse('2026-09-30T05:00:00Z');
    expect(iso(nextFetchSlot(at, 6))).toBe('2026-09-30T06:30:00Z');
    expect(iso(nextFetchSlot(Date.parse('2026-09-30T06:30:00Z'), 6))).toBe('2026-10-01T06:30:00Z');
    expect(addDays('2026-09-30', 2)).toBe('2026-10-02');
    expect(isDay('2026-09-30')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
  });
});

describe('settings', () => {
  it('falls back to the default for missing or invalid rows', () => {
    expect(settingsFrom([])).toEqual({
      categories: ['cs.IR', 'cs.CL', 'cs.LG'],
      lambda: 0.3,
      neuron_cap: null,
      tldr_model: '@cf/ibm-granite/granite-4.0-h-micro',
      ingest_paused: false,
      send_mode: 'subtasks',
    });
    const read = settingsFrom([
      { key: 'categories', value: '["cs.AI"]' },
      { key: 'lambda', value: '2' },
      { key: 'neuron_cap', value: '1500' },
      { key: 'tldr_model', value: '"@cf/unknown/model"' },
      { key: 'ingest_paused', value: 'true' },
      { key: 'send_mode', value: '"separate"' },
      { key: 'categories', value: 'not json' },
    ]);
    expect(read).toMatchObject({ categories: ['cs.AI'], lambda: 0.3, neuron_cap: 1500, tldr_model: '@cf/ibm-granite/granite-4.0-h-micro', ingest_paused: true, send_mode: 'separate' });
  });

  it('validates a PUT body strictly', () => {
    const good = {
      op_id: '0b8a1c9e-6d2f-4a5b-9c3d-1e2f3a4b5c6d',
      categories: ['cs.IR', 'cs.CL'],
      lambda: 0.5,
      neuron_cap: 1200,
      tldr_model: '@cf/qwen/qwen3-30b-a3b-fp8',
      ingest_paused: false,
      send_mode: 'separate',
    };
    expect(parseSettings(good)).toEqual({ categories: ['cs.IR', 'cs.CL'], lambda: 0.5, neuron_cap: 1200, tldr_model: '@cf/qwen/qwen3-30b-a3b-fp8', ingest_paused: false, send_mode: 'separate' });
    for (const bad of [
      { ...good, extra: 1 },
      { ...good, categories: [] },
      { ...good, categories: ['cs.IR', 'cs.IR'] },
      { ...good, categories: ['../x'] },
      { ...good, lambda: 1.5 },
      { ...good, neuron_cap: 1.5 },
      { ...good, tldr_model: '@cf/meta/llama-3.1-70b-instruct' },
      { ...good, ingest_paused: 'no' },
      { ...good, send_mode: 'bulk' },
    ]) {
      expect(() => parseSettings(bad), JSON.stringify(bad)).toThrow(HttpError);
    }
  });
});

describe('the liked list', () => {
  it('keeps LIKE patterns within D1s 50 bytes and escapes wildcards', () => {
    expect(likePattern('  ')).toBeNull();
    expect(likePattern('100%_\\')).toBe('%100\\%\\_\\\\%');
    const long = likePattern('检索'.repeat(40)) ?? '';
    expect(new TextEncoder().encode(long).byteLength).toBeLessThanOrEqual(50);
    expect(long.startsWith('%检索')).toBe(true);
  });

  it('round-trips the cursor and refuses anything else', () => {
    const cursor = { at: 1_790_000_000_000, id: 'arxiv:2609.00001' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor('1~arxiv:x;drop')).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });
});
