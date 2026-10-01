/** The task-intent-v1 JSON Schema and fixtures (contracts/task-intent-v1) and the shared edge cases. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
export const CONTRACT = join(REPO, 'contracts', 'task-intent-v1');
/** Shared with test/python: both codecs must give the same verdict and bytes on every case. */
export const CASES_FILE = join(REPO, 'proto', 'testdata', 'wire-profile-cases.json');

export interface Fixture {
  readonly name: string;
  readonly text: string;
  readonly value: Record<string, unknown>;
}

export function fixtures(def: string, invalid = false): Fixture[] {
  const dir = invalid ? join(CONTRACT, 'fixtures', 'invalid', def) : join(CONTRACT, 'fixtures', def);
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
