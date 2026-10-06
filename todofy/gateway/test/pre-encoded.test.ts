/**
 * PreEncoded's contract (proto/ts/http-transcoder.ts) for the answers the gateway passes through as TodofyCore wrote
 * them (every rpc's but a list's page, src/ui.ts): the transcoder never checks the text, so the answers must be exactly
 * what toWire writes for the rpc's output. Checked here on the stand-in core's answers, the largest TodofyCore gives
 * (test/runtime/fixtures.ts, which the CPU test measures). TodofyCore writes its own with the Python codec and compact
 * separators (worker/todofy/core/owner_ui.py `answer`), whose bytes equal toWire's (proto/test/cross-language.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { DescMessage } from '@ziyixi/proto/protobuf';
import { TodofyUiService } from '@ziyixi/proto/todofy/ui/v1/todofy_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { isPaged } from '../src/ui.ts';
import * as fixtures from './runtime/fixtures.ts';

const reports = fixtures.latestReports() as { summary: unknown; recommendations: unknown[] };

/** One answer of each rpc the gateway passes through. */
const ANSWERS: Readonly<Record<string, Record<string, unknown>>> = {
  GetServiceStatus: fixtures.serviceStatus(),
  GetMailEvent: fixtures.eventDetail(),
  ReconcileMailEvent: fixtures.eventDetail(),
  GetLatestReports: fixtures.latestReports(),
  RecomputeReport: { recommendation: reports.recommendations.at(-1) },
  GetLegacyText: fixtures.legacyText(),
};

/**
 * Where the wire profile writes other bytes for `text` read back as `schema` (an output's lenient read, with nothing
 * unrecognized), or null when it writes `text` itself. Only the bytes around the first difference: a legacy text is 1.9 MB.
 */
function difference(schema: DescMessage, text: string): string | null {
  const read = fromWire(schema, JSON.parse(text));
  if (read.unrecognized.length > 0) return `unrecognized: ${read.unrecognized.join(', ')}`;
  const written = JSON.stringify(toWire(schema, read.message));
  if (written === text) return null;
  let at = 0;
  while (written[at] === text[at]) at++;
  const around = (bytes: string) => JSON.stringify(bytes.slice(Math.max(0, at - 40), at + 40));
  return `from offset ${String(at)}: ${around(text)} is written ${around(written)}`;
}

describe('the answers the gateway passes through', () => {
  it('are every rpc TodofyCore answers but the lists', () => {
    const passed = TodofyUiService.methods.filter((method) => method.name !== 'GetIntegration' && !isPaged(method));
    expect(passed.map((method) => method.name).sort()).toEqual(Object.keys(ANSWERS).sort());
  });

  it('are exactly what toWire writes for the rpc output', () => {
    for (const method of TodofyUiService.methods) {
      const answer = ANSWERS[method.name];
      if (answer === undefined) continue;
      expect(difference(method.output, JSON.stringify(answer)), method.name).toBeNull();
    }
  });

  it('include a summary recompute, written the same way', () => {
    expect(difference(TodofyUiService.method.recomputeReport.output, JSON.stringify({ summary: reports.summary }))).toBeNull();
  });
});
