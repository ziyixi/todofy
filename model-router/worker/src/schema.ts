import { Validator } from '@cfworker/json-schema';
import type { GenerationConfig } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { invalid } from './errors.ts';
import { routeFor } from './catalog.ts';
const encoder = new TextEncoder();
export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
export function validateConfig(config: GenerationConfig): void {
  let route;
  try {
    route = routeFor(config.model);
  } catch {
    invalid('MODEL_NOT_FOUND', 'Choose a configured model.');
  }
  if (!route.generation) invalid('MODEL_CAPABILITY_UNSUPPORTED', 'This model does not generate text.');
  if (config.webResearch && !route.webResearch)
    invalid('MODEL_CAPABILITY_UNSUPPORTED', 'This model does not support web research.');
  const params = config.parameters;
  if (params?.effort && !route.efforts.includes(params.effort))
    invalid('PARAMETER_UNSUPPORTED', 'This model does not support the requested effort.');
  if (params?.temperature !== undefined && !route.temperature)
    invalid('PARAMETER_UNSUPPORTED', 'This model does not support temperature.');
  if (params?.maxOutputTokens !== undefined && !route.maxOutputTokens)
    invalid('PARAMETER_UNSUPPORTED', 'This model does not support an output token cap.');
  if (
    params?.maxOutputTokens !== undefined &&
    (!Number.isInteger(params.maxOutputTokens) || params.maxOutputTokens < 1 || params.maxOutputTokens > 64000)
  )
    invalid('INVALID_PARAMETER', 'Output token cap must be between 1 and 64000.');
  if (config.outputSchemaJson) {
    if (encoder.encode(config.outputSchemaJson).length > 128 * 1024)
      invalid('SCHEMA_TOO_LARGE', 'Output schema exceeds 128 KiB.');
    try {
      new Validator(JSON.parse(config.outputSchemaJson) as ConstructorParameters<typeof Validator>[0]);
    } catch {
      invalid('INVALID_SCHEMA', 'Use a valid standard JSON Schema.');
    }
  }
}
export function validateOutput(config: GenerationConfig, output: string): boolean {
  if (encoder.encode(output).length > 2 * 1024 * 1024) return false;
  if (!config.outputSchemaJson) return !!output.trim();
  try {
    return new Validator(JSON.parse(config.outputSchemaJson) as ConstructorParameters<typeof Validator>[0]).validate(
      JSON.parse(output),
    ).valid;
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
