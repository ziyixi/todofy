import { create } from '@ziyixi/proto/protobuf';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { GenerateRequestSchema } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/schema.ts';

function admit(schema: unknown) {
  return () => validateConfig(create(GenerateRequestSchema, { model: 'gpt-6.1-sol', outputSchemaJson: JSON.stringify(schema) }));
}
function refusal(schema: unknown): RpcError {
  try {
    admit(schema)();
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error('The schema was admitted.');
}
const text = (pattern: string) => ({ type: 'string', pattern });

describe('Output schema admission', () => {
  it('refuses a pattern the answer validator cannot compile, naming its JSON pointer', () => {
    // Python's re.escape writes "\-", an invalid escape in Unicode-mode ECMAScript regular expressions.
    const error = refusal({ type: 'object', properties: { slug: text('^news\\-[0-9]+$') }, required: ['slug'] });
    expect(error).toMatchObject({ code: Code.INVALID_ARGUMENT, reason: 'INVALID_SCHEMA' });
    expect(error.message).toBe('Output schema pattern at /properties/slug/pattern is not a valid Unicode (u flag) regular expression.');
  });

  it.each([
    ['root', text('\\#'), '/pattern'],
    ['anyOf branch', { anyOf: [text('^a$'), { type: 'null' }, text('\\&')] }, '/anyOf/2/pattern'],
    ['oneOf and allOf', { oneOf: [{ allOf: [text('[')] }] }, '/oneOf/0/allOf/0/pattern'],
    ['array items', { type: 'array', items: { type: 'object', properties: { tag: text('\\-') } } }, '/items/properties/tag/pattern'],
    ['tuple items', { type: 'array', prefixItems: [text('a'), text('\\-')] }, '/prefixItems/1/pattern'],
    ['$defs', { $defs: { slug: text('\\-') }, $ref: '#/$defs/slug' }, '/$defs/slug/pattern'],
    ['additionalProperties', { type: 'object', additionalProperties: text('\\-') }, '/additionalProperties/pattern'],
    ['patternProperties key', { type: 'object', patternProperties: { '^x\\-': { type: 'string' } } }, '/patternProperties/^x\\-'],
    ['patternProperties value', { patternProperties: { '^x-': text('\\-') } }, '/patternProperties/^x-/pattern'],
    ['escaped property names', { properties: { 'a/b~c': text('\\-') } }, '/properties/a~1b~0c/pattern'],
  ])('reports an uncompilable pattern in %s', (_, schema, pointer) => {
    expect(refusal(schema).message).toBe(`Output schema pattern at ${pointer} is not a valid Unicode (u flag) regular expression.`);
  });

  it('admits valid patterns and does not read patterns from data keywords or property names', () => {
    expect(admit({
      type: 'object',
      properties: {
        date: text('^\\d{4}-\\d{2}-\\d{2}$'),
        word: text('^[\\p{L}\\-]+$'),
        path: text('^\\/[a-z]+\\.json$'),
        pattern: { type: 'string', description: 'A property named pattern', const: '\\-' },
        patternProperties: { type: 'object', properties: { '\\-': { type: 'string' } } },
        mode: { enum: [{ pattern: '\\-' }], default: { pattern: '\\-' }, examples: [{ pattern: '\\-' }] },
        list: { type: 'array', items: [text('^[a-z]+$')], additionalItems: false },
      },
      patternProperties: { '^x-': { type: 'string' } },
      'x-vendor': { pattern: '\\-' },
    })).not.toThrow();
  });
});
