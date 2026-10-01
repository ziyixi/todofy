/** The task-intent-v1 JSON Schema and fixtures (contracts/task-intent-v1), ops-v1's and mail-received-v1's fixtures, and the
 * shared edge cases. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
export const CONTRACT = join(REPO, 'contracts', 'task-intent-v1');
export const OPS_CONTRACT = join(REPO, 'contracts', 'ops-v1');
export const MAIL_CONTRACT = join(REPO, 'contracts', 'mail-received-v1');
/** Shared with test/python: both codecs must give the same verdict and bytes on every case. */
export const CASES_FILE = join(REPO, 'proto', 'testdata', 'wire-profile-cases.json');

export interface Fixture {
  readonly name: string;
  readonly text: string;
  readonly value: Record<string, unknown>;
}

export function fixtures(def: string, invalid = false, contract = CONTRACT): Fixture[] {
  const dir = invalid ? join(contract, 'fixtures', 'invalid', def) : join(contract, 'fixtures', def);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), 'utf8');
      return { name, text, value: JSON.parse(text) as Record<string, unknown> };
    });
}

interface SchemaDef {
  readonly enum?: readonly string[];
  readonly properties?: Record<string, unknown>;
}

export const SCHEMA = JSON.parse(readFileSync(join(CONTRACT, 'task-intent-v1.schema.json'), 'utf8')) as {
  $defs: Record<string, SchemaDef>;
};

/** mail-received-v1's golden events (exact bytes, no trailing newline): current, or `legacy/` (frozen older builders). */
export function mailFixtures(legacy = false): Fixture[] {
  const dir = legacy ? join(MAIL_CONTRACT, 'fixtures', 'legacy') : join(MAIL_CONTRACT, 'fixtures');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), 'utf8');
      return { name, text, value: JSON.parse(text) as Record<string, unknown> };
    });
}
