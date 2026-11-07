import { Validator, escapePointer, schemaArrayKeyword, schemaKeyword, schemaMapKeyword } from '@cfworker/json-schema';
import type { GenerateRequest } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { invalid } from './errors.ts';
import { routeFor } from './catalog.ts';
const encoder = new TextEncoder();
export const MAX_INPUT_BYTES = 2 * 1024 * 1024;

/** Providers require an object root; Todofy's existing recommendation contract is an array. */
export function providerOutputSchema(schemaJson: string): string {
  if (!schemaJson) return schemaJson;
  const schema = JSON.parse(schemaJson) as { type?: string };
  if (schema.type !== 'array') return schemaJson;
  return JSON.stringify({ type: 'object', properties: { result: schema }, required: ['result'], additionalProperties: false });
}

/** Keep the provider's envelope private and validate the caller's original format afterward. */
export function callerOutput(schemaJson: string, output: string): string {
  if (!schemaJson || (JSON.parse(schemaJson) as { type?: string }).type !== 'array') return output;
  try {
    const value = JSON.parse(output) as Record<string, unknown> | null;
    return value && typeof value === 'object' && !Array.isArray(value) && 'result' in value
      ? JSON.stringify(value.result) : output;
  } catch {
    return output;
  }
}
function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}
/**
 * The validator compiles `pattern` values and `patternProperties` keys with the `u` flag only while checking an
 * answer. Visit each subschema under the validator's own keyword tables once (breadth-first, without recursion)
 * and return the JSON pointer of the first pattern that does not compile. The tables are plain objects, so only
 * their own keys count; an unknown keyword such as `constructor` is not a subschema position.
 */
function uncompiledPattern(root: unknown): string | undefined {
  const pending: [unknown, string][] = [[root, '']];
  for (const [node, pointer] of pending) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const schema = node as Record<string, unknown>;
    if (typeof schema.pattern === 'string' && !compiles(schema.pattern)) return `${pointer}/pattern`;
    for (const [keyword, value] of Object.entries(schema)) {
      const at = `${pointer}/${escapePointer(keyword)}`;
      if (Array.isArray(value)) {
        if (Object.hasOwn(schemaArrayKeyword, keyword)) value.forEach((item, index) => pending.push([item, `${at}/${index}`]));
      } else if (Object.hasOwn(schemaMapKeyword, keyword) && value && typeof value === 'object') {
        for (const [name, child] of Object.entries(value)) {
          if (keyword === 'patternProperties' && !compiles(name)) return `${at}/${escapePointer(name)}`;
          pending.push([child, `${at}/${escapePointer(name)}`]);
        }
      } else if (Object.hasOwn(schemaKeyword, keyword)) pending.push([value, at]);
    }
  }
  return undefined;
}
export function validateConfig(config: GenerateRequest): void {
  let route;
  try {
    route = routeFor(config.model);
  } catch {
    invalid('MODEL_NOT_FOUND', 'Choose a configured model.');
  }
  if (route.provider === 'workers_ai')
    invalid('MODEL_CAPABILITY_UNSUPPORTED', 'This model does not generate text.');
  if (config.effort && !route.efforts.includes(config.effort))
    invalid('PARAMETER_UNSUPPORTED', 'This model does not support the requested effort.');
  if (config.maxOutputTokens && route.provider === 'codex')
    invalid('PARAMETER_UNSUPPORTED', 'Codex does not support an output token cap.');
  if (
    config.maxOutputTokens &&
    (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 1 || config.maxOutputTokens > 64000)
  )
    invalid('INVALID_PARAMETER', 'Output token cap must be between 1 and 64000.');
  if (config.outputSchemaJson) {
    if (encoder.encode(config.outputSchemaJson).length > 128 * 1024)
      invalid('SCHEMA_TOO_LARGE', 'Output schema exceeds 128 KiB.');
    let schema: unknown;
    try {
      schema = JSON.parse(config.outputSchemaJson);
      new Validator(schema as ConstructorParameters<typeof Validator>[0]);
    } catch {
      invalid('INVALID_SCHEMA', 'Use a valid standard JSON Schema.');
    }
    const pointer = uncompiledPattern(schema);
    if (pointer !== undefined)
      invalid('INVALID_SCHEMA', `Output schema pattern at ${pointer} is not a valid Unicode (u flag) regular expression.`);
  }
}
export function validateOutput(config: GenerateRequest, output: string): boolean {
  if (encoder.encode(output).length > 2 * 1024 * 1024) return false;
  if (!config.outputSchemaJson) return !!output.trim();
  try {
    const schema = JSON.parse(config.outputSchemaJson) as ConstructorParameters<typeof Validator>[0];
    const validator = new Validator(schema);
    return validator.validate(JSON.parse(output)).valid;
  } catch {
    return false;
  }
}
export function budget(value: number): number {
  const result = value || 110000;
  if (!Number.isInteger(result) || result < 1000 || result > 840000)
    invalid('INVALID_DEADLINE', 'Timeout must be between 1000 and 840000 ms.');
  return result;
}
