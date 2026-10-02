import { describe, expect, it } from 'vitest';
import limitsDoc from '../../docs/limits.md?raw';
import { QUOTA_RESOURCES } from '../src/idl.ts';
import { ALLOWANCES } from '../src/limits.ts';

/** The §1 table of docs/limits.md: resource id → its cells. */
function documentedRows(): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of limitsDoc.split('\n')) {
    const match = /^\| `([a-z0-9_]+)` \|(.*)\|$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    rows.set(match[1], match[2].split('|').map((cell) => cell.trim()));
  }
  return rows;
}

describe('docs/limits.md and limits.ts', () => {
  const rows = documentedRows();

  it('documents every quota resource and nothing else', () => {
    expect([...rows.keys()].sort()).toEqual([...QUOTA_RESOURCES].sort());
  });

  it.each(Object.entries(ALLOWANCES))('%s has the same value, guard flag and source', (id, allowance) => {
    const cells = rows.get(id);
    expect(cells).toBeDefined();
    const [, , value, trigger, source] = cells ?? [];
    expect(Number(value)).toBe(allowance.limit);
    expect(trigger).toBe(allowance.guardTrigger ? 'yes' : 'no');
    expect(source).toContain(`(${allowance.source})`);
  });
});
