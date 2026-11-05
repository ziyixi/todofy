import { expect, test } from 'vitest';
import { TASK_COLORS } from '../../shared/colors.ts';

test('TASK_COLORS exposes 20 unique named palette entries with lowercase 6-digit hex codes', () => {
  expect(TASK_COLORS).toHaveLength(20);
  const keys = new Set<string>();
  const names = new Set<string>();
  const hexes = new Set<string>();
  for (const entry of TASK_COLORS) {
    expect(entry.key).toMatch(/^[a-z_]+$/);
    expect(entry.name.trim().length).toBeGreaterThan(0);
    expect(entry.hex).toMatch(/^#[0-9a-f]{6}$/);
    keys.add(entry.key);
    names.add(entry.name);
    hexes.add(entry.hex);
  }
  expect(keys.size).toBe(20);
  expect(names.size).toBe(20);
  expect(hexes.size).toBe(20);
});
