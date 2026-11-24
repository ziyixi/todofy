import { describe, expect, it } from 'vitest';
import limitsDoc from '../../docs/limits.md?raw';
import { QUOTA_RESOURCES } from '../src/idl.ts';
import { ALLOWANCES, FREE_QUOTA_RESOURCES, PAID_ALLOWANCES } from '../src/limits.ts';

/** A §1 table of docs/limits.md: resource id → its cells. */
function documentedRows(sectionHeading: string): Map<string, string[]> {
  const after = limitsDoc.split(sectionHeading, 2)[1] ?? '';
  const body = after.split(/\n###? /, 1)[0] ?? '';
  const rows = new Map<string, string[]>();
  for (const line of body.split('\n')) {
    const match = /^\| `([a-z0-9_]+)` \|(.*)\|$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    rows.set(match[1], match[2].split('|').map((cell) => cell.trim()));
  }
  return rows;
}

describe('docs/limits.md and limits.ts', () => {
  const freeRows = documentedRows('### 1.1 Workers Free');
  const paidRows = documentedRows('### 1.2 Workers Paid');

  it('documents every quota resource and nothing else for both plans', () => {
    expect([...freeRows.keys()].sort()).toEqual([...FREE_QUOTA_RESOURCES].sort());
    expect([...paidRows.keys()].sort()).toEqual([...QUOTA_RESOURCES].sort());
  });

  it.each(Object.entries(ALLOWANCES))('free %s has the same value, guard flag and source', (id, allowance) => {
    const cells = freeRows.get(id);
    expect(cells).toBeDefined();
    const [, , value, trigger, source] = cells ?? [];
    expect(Number(value)).toBe(allowance.limit);
    expect(trigger).toBe(allowance.guardTrigger ? 'yes' : 'no');
    expect(source).toContain(`(${allowance.source})`);
  });

  it.each(Object.entries(PAID_ALLOWANCES))('paid %s has the same value, guard flag and source', (id, allowance) => {
    const cells = paidRows.get(id);
    expect(cells).toBeDefined();
    const [, , value, trigger, source] = cells ?? [];
    expect(Number(value)).toBe(allowance.limit);
    expect(trigger).toBe(allowance.guardTrigger ? 'yes' : 'no');
    expect(source).toContain(`(${allowance.source})`);
  });
});
