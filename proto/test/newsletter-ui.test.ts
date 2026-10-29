/**
 * newsletter.ui.v1 (contracts/newsletter-ui-v1) before Newsletter or its console imports it: what both sides will rely
 * on. The console Worker's transcoder builds the routes, all GET, and sends each path to its method. Newsletter's
 * Python listener decodes the same requests with the shared http_routes, which reads only integer and string query
 * parameters, and its generator (tools/gen_py.py) takes no oneof, 64-bit integer, float, bytes or nested message, so
 * adding the package to PYTHON_PACKAGES cannot stop generation for every Python user. Every answer field is
 * OUTPUT_ONLY or IDENTIFIER, never REQUIRED: no producer writes null, so the bytes Newsletter writes are the bytes toWire
 * writes, which the Worker passes through as PreEncoded without parsing them. The golden answers Newsletter's reader
 * writes (contracts/newsletter-ui-v1/fixtures, newsletter/scripts/console_fixtures.py) prove it: each reads back and
 * writes again byte for byte.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { create, getOption, ScalarType, type DescField, type DescMessage } from '@bufbuild/protobuf';
import { field_behavior, FieldBehavior } from '../ts/google/api/field_behavior_pb.ts';
import { httpBindings } from '../ts/http-rule.ts';
import { HttpTranscoder, type ServiceHandlers, type ShapeOf } from '../ts/http-transcoder.ts';
import { NewsletterUiService } from '../ts/newsletter/ui/v1/newsletter_ui_service_pb.ts';
import { RunFailure_Kind, RunSchema, Run_State } from '../ts/newsletter/ui/v1/run_pb.ts';
import type * as wire from '../ts/newsletter/ui/v1/run_wire.ts';
import { fromWire, toWire } from '../ts/wire-json.ts';

type Handlers = ServiceHandlers<ShapeOf<typeof NewsletterUiService>, Record<string, never>>;

const PACKAGE = 'newsletter.ui.v1';
const WELL_KNOWN = new Set(['google.protobuf.Timestamp', 'google.protobuf.FieldMask']);
const PYTHON_SCALARS = new Set([ScalarType.STRING, ScalarType.BOOL, ScalarType.INT32, ScalarType.DOUBLE]);

/** Every message of the package that a method takes or answers, with the messages they contain. */
function reachable(roots: readonly DescMessage[]): DescMessage[] {
  const seen = new Map<string, DescMessage>();
  const visit = (message: DescMessage): void => {
    if (!message.typeName.startsWith(`${PACKAGE}.`) || seen.has(message.typeName)) return;
    seen.set(message.typeName, message);
    for (const field of message.fields) {
      if (field.fieldKind === 'message' || (field.fieldKind === 'list' && field.listKind === 'message')) visit(field.message);
      if (field.fieldKind === 'map' && field.mapKind === 'message') visit(field.message);
    }
  };
  roots.forEach(visit);
  return [...seen.values()];
}

/** Why `field` falls outside the Python wire profile, or null. */
function outsidePythonProfile(field: DescField): string | null {
  if (field.oneof !== undefined) return 'a oneof';
  const message = field.fieldKind === 'message' || (field.fieldKind === 'list' && field.listKind === 'message') || (field.fieldKind === 'map' && field.mapKind === 'message')
    ? field.message
    : undefined;
  if (message && !message.typeName.startsWith(`${PACKAGE}.`) && !WELL_KNOWN.has(message.typeName)) return `the type ${message.typeName}`;
  if (field.fieldKind === 'map' && field.mapKey !== ScalarType.STRING) return 'a map key that is not a string';
  const scalar = field.fieldKind === 'scalar' ? field.scalar
    : field.fieldKind === 'list' && field.listKind === 'scalar' ? field.scalar
    : field.fieldKind === 'map' && field.mapKind === 'scalar' ? field.scalar
    : undefined;
  if (scalar !== undefined && !PYTHON_SCALARS.has(scalar)) return `the scalar ${ScalarType[scalar]}`;
  return null;
}

const FIXTURES = join(import.meta.dirname, '..', '..', 'contracts', 'newsletter-ui-v1', 'fixtures');
/** Each golden answer and the method that answers it. */
const ANSWERS = {
  'overview': NewsletterUiService.method.getOverview,
  'runs': NewsletterUiService.method.listRuns,
  'run-blocked-selection-timeout': NewsletterUiService.method.getRun,
  'run-ready': NewsletterUiService.method.getRun,
  'model-calls': NewsletterUiService.method.listModelCalls,
  'model-usage-30d': NewsletterUiService.method.summarizeModelUsage,
  'editions': NewsletterUiService.method.listEditions,
  'edition': NewsletterUiService.method.getEdition,
  'edition-rendering': NewsletterUiService.method.getEditionRendering,
  'source-catalog': NewsletterUiService.method.getSourceCatalog,
  'backup-status': NewsletterUiService.method.getBackupStatus,
} as const;

const methods = NewsletterUiService.methods;
const inputs = reachable(methods.map((method) => method.input));
const outputs = reachable(methods.map((method) => method.output));

describe('newsletter.ui.v1', () => {
  test('every method is one GET binding, and the transcoder sends each path to its method', async () => {
    const bindings = httpBindings(NewsletterUiService);
    expect(bindings.map((binding) => [binding.method.name, binding.httpMethod, binding.body])).toEqual(
      methods.map((method) => [method.name, 'GET', '']),
    );
    const called: string[] = [];
    const handlers = Object.fromEntries(methods.map((method) => [method.localName, (request: object) => {
      called.push(`${method.name} ${JSON.stringify(toWire(method.input, request as never))}`);
      return Promise.resolve(create(method.output));
    }])) as unknown as Handlers;
    // The Worker admits GET and HEAD only and reads no body (maxBodyBytes 0).
    const api = new HttpTranscoder(NewsletterUiService, handlers, { domain: 'news.ziyixi.science', maxBodyBytes: 0, authorize: () => undefined });
    const paths = [
      '/api/v1/overview',
      '/api/v1/runs?month=2026-10&page_size=10',
      '/api/v1/runs/r1',
      '/api/v1/runs/r1/modelCalls',
      '/api/v1/runs:summarizeModelUsage?day_count=30',
      '/api/v1/editions?month=2026-10',
      '/api/v1/editions/e1',
      '/api/v1/editions/e1/rendering',
      '/api/v1/sourceCatalog',
      '/api/v1/backupStatus',
    ];
    for (const path of paths) expect((await api.handle(new Request(`https://news.ziyixi.science${path}`), {}))?.response.status, path).toBe(200);
    expect(called).toEqual([
      'GetOverview {"name":"overview"}',
      'ListRuns {"page_size":10,"month":"2026-10"}',
      'GetRun {"name":"runs/r1"}',
      'ListModelCalls {"parent":"runs/r1"}',
      'SummarizeModelUsage {"day_count":30}',
      'ListEditions {"month":"2026-10"}',
      'GetEdition {"name":"editions/e1"}',
      'GetEditionRendering {"name":"editions/e1/rendering"}',
      'GetSourceCatalog {"name":"sourceCatalog"}',
      'GetBackupStatus {"name":"backupStatus"}',
    ]);
    expect((await api.handle(new Request('https://news.ziyixi.science/api/v1/runs', { method: 'POST', body: '{}' }), {}))?.response.status).toBe(405);
  });

  test("every request field is a string or an int32, the query parameter kinds Newsletter's Python decoder reads", () => {
    for (const method of methods) {
      for (const field of method.input.fields) {
        expect(field.fieldKind === 'scalar' && [ScalarType.STRING, ScalarType.INT32].includes(field.scalar), `${method.name}.${field.name}`).toBe(true);
      }
    }
  });

  test('every message fits the Python wire profile: top-level messages, no oneof, only its scalars and types', () => {
    expect(outputs.length).toBeGreaterThan(30);
    for (const message of [...inputs, ...outputs]) {
      expect(message.parent, `${message.typeName} is nested`).toBeUndefined();
      expect(message.oneofs, message.typeName).toEqual([]);
      for (const field of message.fields) expect(outsidePythonProfile(field), `${message.typeName}.${field.name}`).toBeNull();
    }
  });

  test('every answer field is OUTPUT_ONLY or IDENTIFIER and never REQUIRED, so no producer writes null', () => {
    for (const message of outputs) {
      for (const field of message.fields) {
        const behavior = getOption(field, field_behavior);
        expect(behavior.includes(FieldBehavior.REQUIRED), `${message.typeName}.${field.name}`).toBe(false);
        expect(behavior.includes(FieldBehavior.OUTPUT_ONLY) || behavior.includes(FieldBehavior.IDENTIFIER), `${message.typeName}.${field.name}`).toBe(true);
      }
    }
    // An unset field is left out, and an explicitly present optional scalar is written even at zero.
    const run = create(RunSchema, {
      name: 'runs/r1',
      issueDate: '2026-10-28',
      state: Run_State.BLOCKED,
      stopReason: 'no_publishable_content',
      failure: { nodeId: 'selection', errorCode: 'timeout', kind: RunFailure_Kind.NODE_BUDGET, elapsedSeconds: 171.25, budgetSeconds: 150 },
      feeds: { sourceCount: 35, okCount: 35, seedCount: 0 },
    });
    const written: wire.Run = toWire(RunSchema, run);
    expect(JSON.stringify(written)).toBe(
      '{"name":"runs/r1","issue_date":"2026-10-28","state":"blocked","stop_reason":"no_publishable_content",' +
        '"failure":{"node_id":"selection","error_code":"timeout","kind":"node_budget","elapsed_seconds":171.25,"budget_seconds":150},' +
        '"feeds":{"source_count":35,"ok_count":35,"seed_count":0}}',
    );
  });
});

describe('Newsletter’s golden answers are the codec’s bytes', () => {
  test('there is one fixture per golden answer', () => {
    const files = readdirSync(FIXTURES).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
    expect(files.sort()).toEqual(Object.keys(ANSWERS).sort());
  });

  test.each(Object.entries(ANSWERS))('%s reads back strictly and writes the same bytes', (name, method) => {
    const text = readFileSync(join(FIXTURES, `${name}.json`), 'utf8');
    const { message, unrecognized } = fromWire(method.output, JSON.parse(text), { strict: true });
    expect(unrecognized).toEqual([]);
    expect(JSON.stringify(toWire(method.output, message))).toBe(text);
  });
});
