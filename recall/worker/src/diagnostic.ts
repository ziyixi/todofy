/** One owner-requested capture report, kept outside browsing history and the archive feed. */
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import type { CaptureDiagnostic } from '@ziyixi/proto/recall/ingest/v1/diagnostic_pb';
import { CaptureDiagnosticReportSchema, type CaptureDiagnosticReport } from '@ziyixi/proto/recall/ui/v1/status_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import type { Store } from './store.ts';

const META_KEY = 'capture_diagnostic';

export function saveCaptureDiagnostic(store: Store, deviceId: string, diagnostic: CaptureDiagnostic, receivedMs: number): void {
  const report = create(CaptureDiagnosticReportSchema, { deviceId, receiveTime: timestampFromMs(receivedMs), diagnostic });
  store.setMeta(META_KEY, JSON.stringify(toWire(CaptureDiagnosticReportSchema, report)));
}

export function readCaptureDiagnostic(store: Store): CaptureDiagnosticReport | undefined {
  const value = store.getMeta(META_KEY);
  return value === null ? undefined : fromWire(CaptureDiagnosticReportSchema, JSON.parse(value), { strict: true }).message;
}
