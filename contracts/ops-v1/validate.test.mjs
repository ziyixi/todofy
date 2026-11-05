import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validate } from './validate.mjs';

const opsSchema = JSON.parse(
  readFileSync(new URL('./ops-v1.schema.json', import.meta.url), 'utf8'),
);

test('validate accepts a valid OpsStatus payload and rejects missing required fields, unknown fields, bad enums, and bad timestamps', () => {
  const validStatus = {
    version: 'ops-v1',
    app: 'watch',
    generated_at: '2026-10-20T12:00:00Z',
    health: 'ok',
    modes: { maintenance: false },
    guard: {
      level: 'normal',
      reason: null,
      until: null,
      set_at: null,
      deferred: [],
    },
    signals: [],
    counters: {},
    last_backup_at: null,
    ui_url: 'https://watch.example.com/',
    capabilities: [],
  };
  assert.deepEqual(validate(opsSchema, 'OpsStatus', validStatus), []);

  const missingRequired = { ...validStatus };
  delete missingRequired.app;
  assert.ok(
    validate(opsSchema, 'OpsStatus', missingRequired).some((err) =>
      err.includes('missing app'),
    ),
  );

  const extraField = { ...validStatus, unknown_field: true };
  assert.ok(
    validate(opsSchema, 'OpsStatus', extraField).some((err) =>
      err.includes('/unknown_field: not allowed'),
    ),
  );

  const badEnum = {
    ...validStatus,
    health: 'broken',
  };
  assert.ok(
    validate(opsSchema, 'OpsStatus', badEnum).some((err) =>
      err.includes('/health: not one of'),
    ),
  );

  const badTimestamp = {
    ...validStatus,
    generated_at: 'not-a-timestamp',
  };
  assert.ok(
    validate(opsSchema, 'OpsStatus', badTimestamp).some((err) =>
      err.includes('/generated_at: does not match'),
    ),
  );
});

test('validate throws on missing $defs entry, unsupported keywords, and invalid $ref targets', () => {
  assert.throws(
    () => validate({ $defs: {} }, 'Missing', {}),
    /no \$defs entry Missing/,
  );
  assert.throws(
    () => validate({}, 'Missing', {}),
    /no \$defs entry Missing/,
  );
  assert.throws(
    () =>
      validate(
        { $defs: { Entry: { allOf: [] } } },
        'Entry',
        {},
      ),
    /validate\.mjs does not implement the keyword "allOf"/,
  );
  assert.throws(
    () =>
      validate(
        { $defs: { Entry: { $ref: 'https://example.com/schema.json' } } },
        'Entry',
        {},
      ),
    /unsupported \$ref/,
  );
  assert.throws(
    () =>
      validate(
        { $defs: { Entry: { $ref: '#/$defs/UnknownTarget' } } },
        'Entry',
        {},
      ),
    /unsupported \$ref #\/\$defs\/UnknownTarget/,
  );
});

test('validate covers boolean schemas, type unions, enum, const, oneOf, anyOf, strings, numbers, arrays, and objects', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      AlwaysTrue: true,
      AlwaysFalse: false,
      Tag: {
        type: 'string',
        minLength: 2,
        maxLength: 3,
        pattern: '^[a-z😀]+$',
      },
      Item: {
        type: 'object',
        minProperties: 1,
        maxProperties: 3,
        required: ['id'],
        propertyNames: { pattern: '^[a-z_]+$' },
        properties: {
          id: { const: { nested: [1, 2] } },
          choice: { enum: ['alpha', { complex: true }] },
          score: { type: 'number', minimum: 0, maximum: 10 },
          count: { type: ['integer', 'null'] },
          tag: { $ref: '#/$defs/Tag' },
          list: {
            type: 'array',
            minItems: 1,
            maxItems: 2,
            uniqueItems: true,
            items: { type: 'object' },
          },
          one: {
            oneOf: [
              { type: 'number', minimum: 0 },
              { type: 'number', maximum: 5 },
            ],
          },
          any: {
            anyOf: [{ const: 'yes' }, { const: 'ok' }],
          },
        },
        additionalProperties: false,
      },
    },
  };

  assert.deepEqual(validate(schema, 'AlwaysTrue', 'anything'), []);
  assert.deepEqual(validate(schema, 'AlwaysFalse', 'anything'), [
    ': not allowed',
  ]);

  // Valid item (including multi-byte UTF-8 code point counting as 1 code point in minLength/maxLength)
  assert.deepEqual(
    validate(schema, 'Item', {
      id: { nested: [1, 2] },
      choice: { complex: true },
      score: 10,
    }),
    [],
  );
  assert.deepEqual(validate(schema, 'Tag', '😀😀'), []);

  // Type mismatch (single and union)
  assert.deepEqual(validate(schema, 'Item', null), [': expected object']);
  assert.deepEqual(
    validate(schema, 'Item', { id: { nested: [1, 2] }, count: 1.5 }),
    ['/count: expected integer or null'],
  );

  // String length & pattern errors
  assert.deepEqual(validate(schema, 'Tag', 'a'), [': shorter than 2']);
  assert.deepEqual(validate(schema, 'Tag', 'abcd'), [': longer than 3']);
  assert.deepEqual(validate(schema, 'Tag', 'AB'), [
    ': does not match ^[a-z😀]+$',
  ]);

  // Number bounds, const, enum, oneOf (0 and 2 matches), anyOf (0 matches)
  const badValues = validate(schema, 'Item', {
    id: { nested: [1, 3] },
    choice: { complex: false },
    score: -1,
  });
  assert.deepEqual(badValues, [
    '/id: must be {"nested":[1,2]}',
    '/choice: not one of ["alpha",{"complex":true}]',
    '/score: below 0',
  ]);

  assert.deepEqual(
    validate(schema, 'Item', {
      id: { nested: [1, 2] },
      score: 11,
      one: 3,
      any: 'no',
    }),
    [
      ': more than 3 properties',
      '/score: above 10',
      '/one: 2 of 2 oneOf branches match',
      '/any: 0 of 2 anyOf branches match',
    ],
  );

  assert.deepEqual(
    validate(schema, 'Item', {
      id: { nested: [1, 2] },
      one: 'bad',
    }),
    ['/one: 0 of 2 oneOf branches match'],
  );

  // Array bounds, uniqueItems with deep objects, and items check
  assert.deepEqual(
    validate(schema, 'Item', {
      id: { nested: [1, 2] },
      list: [],
    }),
    ['/list: fewer than 1 items'],
  );
  assert.deepEqual(
    validate(schema, 'Item', {
      id: { nested: [1, 2] },
      list: [{ a: 1 }, { a: 1 }, 'bad'],
    }),
    [
      '/list: more than 2 items',
      '/list: items are not unique',
      '/list/2: expected object',
    ],
  );

  // Object minProperties, maxProperties, required, propertyNames, additionalProperties
  assert.deepEqual(validate(schema, 'Item', {}), [
    ': fewer than 1 properties',
    ': missing id',
  ]);
  assert.deepEqual(
    validate(schema, 'Item', {
      id: { nested: [1, 2] },
      score: 1,
      count: 2,
      BAD_NAME: 3,
    }),
    [
      ': more than 3 properties',
      '/BAD_NAME(name): does not match ^[a-z_]+$',
      '/BAD_NAME: not allowed',
    ],
  );
});
