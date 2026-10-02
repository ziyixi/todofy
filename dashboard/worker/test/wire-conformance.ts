/**
 * The proof that the JSON HomeState and the Worker serialize themselves is exactly what dashboard.ui.v1 says
 * (proto/dashboard/ui/v1): the Worker passes those bytes through without decoding them (src/api.ts, PreEncoded), so
 * the transcoder never checks them. A body conforms when the UI's read (the client's, an output's) accepts it with
 * nothing unrecognized (no unknown field or enum name, no wrong type, every value rule kept, every REQUIRED field
 * there, null only where the profile writes it) and the wire profile writes the message read back to the same bytes
 * (fields in their numbered order, nulls and omissions where the profile puts them). The unit
 * tests run it on every view they build (test/views.test.ts, test/registry.test.ts), the workerd tests on every
 * answer of the real Worker (test/runtime/flows.ts).
 */
import { expect } from 'vitest';
import type { DescMessage } from '@ziyixi/proto/protobuf';
import { CloudflareViewSchema } from '@ziyixi/proto/dashboard/ui/v1/cloudflare_view_pb';
import { FlowsViewSchema } from '@ziyixi/proto/dashboard/ui/v1/flows_view_pb';
import { HomeViewSchema } from '@ziyixi/proto/dashboard/ui/v1/home_view_pb';
import { OpsViewSchema } from '@ziyixi/proto/dashboard/ui/v1/ops_view_pb';
import { RegistrySchema } from '@ziyixi/proto/dashboard/ui/v1/registry_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import type { ViewId } from '../src/api-types.ts';

/** The message of each view's body. */
export const VIEW_SCHEMAS: Readonly<Record<ViewId | 'registry', DescMessage>> = {
  registry: RegistrySchema,
  home: HomeViewSchema,
  flows: FlowsViewSchema,
  cloudflare: CloudflareViewSchema,
  ops: OpsViewSchema,
};

/** Why `text` does not conform to `schema`, or null when it does. */
export function nonConformance(schema: DescMessage, text: string): string | null {
  let read;
  try {
    read = fromWire(schema, JSON.parse(text));
  } catch (error) {
    return `the read refuses it: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (read.unrecognized.length > 0) return `the read does not know ${read.unrecognized.join(', ')}`;
  const written = JSON.stringify(toWire(schema, read.message));
  if (written === text) return null;
  let at = 0;
  while (at < written.length && written[at] === text[at]) at++;
  return `the wire profile writes other bytes from offset ${String(at)}: ${JSON.stringify(text.slice(Math.max(0, at - 40), at + 40))} became ${JSON.stringify(written.slice(Math.max(0, at - 40), at + 40))}`;
}

/** Asserts that `value` (a body string, or the object a builder made, serialized as HomeState does) conforms. */
export function expectWire<T>(schema: DescMessage, value: T): T {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  expect(nonConformance(schema, text), schema.typeName).toBeNull();
  return value;
}
