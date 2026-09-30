/**
 * contracts/task-intent-v1: the fixtures against the schema (with ops-v1's dependency-free validator, the
 * same subset Todofy's Python jsonschema check must agree with) and the TS constants against the schema.
 * Lab is the proposer: the intents it builds and the results it stores must pass the same checks.
 */
import { describe, expect, it } from 'vitest';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import schema from '../../../contracts/task-intent-v1/task-intent-v1.schema.json';
import {
  TASK_INTENT_ERROR_CODES,
  TASK_INTENT_LIMITS,
  TASK_INTENT_MODES,
  TASK_INTENT_SOURCES,
  TASK_INTENT_STATES,
  TASK_INTENT_URL_HOSTS,
  TASK_INTENT_VERSION,
} from '../../../contracts/task-intent-v1/task-intent-v1.ts';

const valid = import.meta.glob('../../../contracts/task-intent-v1/fixtures/*/*.json', { import: 'default', eager: true });
const invalid = import.meta.glob('../../../contracts/task-intent-v1/fixtures/invalid/*/*.json', { import: 'default', eager: true });
const DEFS = ['TaskIntent', 'TaskIntentRef', 'TaskIntentResult'];

function defOf(path: string): string {
  const match = /fixtures\/(?:invalid\/)?([^/]+)\/[^/]+\.json$/.exec(path);
  if (!match?.[1] || !DEFS.includes(match[1])) throw new Error(`fixture outside a known $defs folder: ${path}`);
  return match[1];
}

type Json = Record<string, unknown>;
const defs = (schema as { $defs: Record<string, Json> }).$defs;
const props = (name: string) => (defs[name]?.['properties'] ?? {}) as Record<string, Json>;

describe('task-intent-v1 fixtures', () => {
  it('has fixtures for every definition, valid and invalid', () => {
    for (const def of DEFS) {
      expect(Object.keys(valid).some((path) => defOf(path) === def), def).toBe(true);
      expect(Object.keys(invalid).some((path) => defOf(path) === def), def).toBe(true);
    }
  });

  it('accepts every valid fixture', () => {
    for (const [path, value] of Object.entries(valid)) expect(validate(schema, defOf(path), value), path).toEqual([]);
  });

  it('refuses every invalid fixture', () => {
    for (const [path, value] of Object.entries(invalid)) expect(validate(schema, defOf(path), value).length, path).toBeGreaterThan(0);
  });

  it('keeps every intent id unique across the valid intent fixtures', () => {
    const ids = Object.entries(valid)
      .filter(([path]) => defOf(path) === 'TaskIntent')
      .map(([, value]) => (value as { intent_id: string }).intent_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('links only to hosts the source may use', () => {
    for (const [path, value] of Object.entries(valid)) {
      if (defOf(path) !== 'TaskIntent') continue;
      const intent = value as { source: 'lab'; items: { url?: string }[] };
      for (const item of intent.items) {
        if (item.url !== undefined) expect(TASK_INTENT_URL_HOSTS[intent.source]).toContain(new URL(item.url).hostname);
      }
    }
  });
});

describe('task-intent-v1.ts constants', () => {
  it('match the schema', () => {
    expect(defs['Version']?.['const']).toBe(TASK_INTENT_VERSION);
    expect(defs['Source']?.['enum']).toEqual([...TASK_INTENT_SOURCES]);
    expect(defs['Mode']?.['enum']).toEqual([...TASK_INTENT_MODES]);
    expect(defs['State']?.['enum']).toEqual([...TASK_INTENT_STATES]);
    expect(defs['ErrorCode']?.['enum']).toEqual([...TASK_INTENT_ERROR_CODES]);
    expect(Object.keys(TASK_INTENT_URL_HOSTS)).toEqual([...TASK_INTENT_SOURCES]);
    const items = props('TaskIntent')['items'] ?? {};
    expect(items['maxItems']).toBe(TASK_INTENT_LIMITS.itemsMax);
    expect(defs['ParentTitle']?.['maxLength']).toBe(TASK_INTENT_LIMITS.parentTitleMax);
    expect(defs['ItemTitle']?.['maxLength']).toBe(TASK_INTENT_LIMITS.itemTitleMax);
    expect(defs['BlockText']?.['maxLength']).toBe(TASK_INTENT_LIMITS.descriptionMax);
    expect(defs['HttpsUrl']?.['maxLength']).toBe(TASK_INTENT_LIMITS.urlMax);
    expect(props('TaskIntentResult')['tasks_total']?.['maximum']).toBe(TASK_INTENT_LIMITS.tasksMax);
    expect(props('TaskIntentResult')['tasks_created']?.['maximum']).toBe(TASK_INTENT_LIMITS.tasksMax);
  });
});
