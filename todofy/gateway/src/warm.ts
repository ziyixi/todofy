/**
 * The codec's first run, at startup instead of in an isolate's first owner API request.
 *
 * The gateway reads the lists' pages TodofyCore answers (and the MailEvent of a refusal) with the generated code and
 * writes them again (ui.ts), and the first time the wire codec meets a kind of field it does work no later request
 * repeats: it reads each field's options from the descriptors (field_behavior, the value rules), compiles the rules'
 * regular expressions (a timestamp) and runs its code paths for the first time. In an isolate's first API request
 * that cost about 3.3 ms more of Workers Free's 10 ms (reference ms, test/runtime/cpu.test.ts). The global scope runs
 * once per isolate, before its first request and outside every request's CPU limit (Workers' startup limit is
 * separate), so the gateway reads and writes one small synthetic answer of each kind there: every field kind it reads
 * (nested messages, enums, timestamps, a map, optional integers). Every other answer passes through unread. The
 * samples are synthetic and never leave the isolate.
 */
import type { DescMessage } from '@ziyixi/proto/protobuf';
import { MetricDaySchema } from '@ziyixi/proto/todofy/ui/v1/history_pb';
import { MailEventSchema } from '@ziyixi/proto/todofy/ui/v1/mail_event_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';

const AT = '2026-01-01T00:00:00Z';

const SAMPLES: readonly (readonly [DescMessage, Record<string, unknown>])[] = [
  [
    MailEventSchema,
    {
      name: 'mailEvents/00000000-0000-4000-8000-000000000000',
      state: 'todo_unknown',
      error_code: 'lookup_not_found',
      receive_time: AT,
      etag: '1',
      allowed_actions: ['dismiss'],
      transitions: [{ transition_time: AT, prior_state: 'pending', state: 'summarized', error_code: 'summary_failed', actor: 'worker' }],
      legacy_text: 'legacyTexts/00000000-0000-4000-8000-000000000000',
    },
  ],
  [MetricDaySchema, { name: 'metricDays/2026-01-01', recorded: true, latency_p50_seconds: 1, gemini_tokens: { m: 1 } }],
];

/** Reads and writes each sample once (owner.ts calls it at global scope). */
export function warmCodec(): void {
  for (const [schema, wire] of SAMPLES) toWire(schema, fromWire(schema, wire).message);
}
