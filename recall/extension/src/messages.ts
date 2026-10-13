/**
 * The messages between the options page and the service worker (chrome.runtime.sendMessage, from the extension's own
 * pages only): the status, saving the settings, 立即上传 and 检查更新.
 */
import type { CaptureStatus, LastError, UploadState } from './store.ts';
import type { CaptureDiagnosticStep } from '@ziyixi/proto/recall/ingest/v1/diagnostic_wire';

export interface SaveRequest {
  readonly server: string;
  readonly label: string;
  /** A new ingest token, or '' to keep the saved one. */
  readonly token: string;
}

export type Request =
  | { readonly type: 'status' }
  | ({ readonly type: 'save' } & SaveRequest)
  | { readonly type: 'flush' }
  | { readonly type: 'check-update' }
  | { readonly type: 'diagnostic-start' | 'diagnostic-send' | 'diagnostic-status' };

export interface DiagnosticStatus {
  readonly state: 'idle' | 'running' | 'stopped' | 'sent';
  readonly runId: string;
  readonly expiresAt: number;
  readonly stepCount: number;
  readonly tabEvents: number;
  readonly alarmEvents: number;
  readonly sentAt: number;
  readonly latestStage: string;
  readonly latestState: string;
  readonly steps: readonly CaptureDiagnosticStep[];
}

export interface DiagnosticAnswer {
  readonly ok: boolean;
  readonly error?: 'unsupported' | 'token_missing' | 'open_failed' | 'send_failed' | 'no_run';
  readonly diagnostic: DiagnosticStatus;
}

export type SaveAnswer = { readonly ok: true } | { readonly ok: false; readonly error: 'server_invalid' | 'label_invalid' | 'token_invalid' | 'token_export' };

export interface Status {
  readonly now: number;
  readonly mobile?: boolean;
  readonly capture?: CaptureStatus | null;
  readonly capabilities?: { readonly script: boolean; readonly screenshot: boolean };
  readonly focused?: boolean;
  readonly lastFocusCheckAt?: number;
  /** Ongoing local visits; uploaded items leave the separate outbox. */
  readonly localVisitCount?: number;
  readonly version: string;
  /** The build's short commit. */
  readonly versionName: string;
  readonly deviceId: string;
  readonly label: string;
  readonly server: string;
  readonly tokenSet: boolean;
  /** Items in the outbox. */
  readonly queued: number;
  /** Of them, items recall could not read yet (it is older than this build), held to be sent again later. */
  readonly held: number;
  readonly upload: UploadState;
  readonly lastError: LastError | null;
}

export interface UpdateAnswer {
  /** A newer build is installed in the extension's folder and the extension reloads now. */
  readonly reloading: boolean;
}

export function isRequest(value: unknown): value is Request {
  if (typeof value !== 'object' || value === null) return false;
  const { type } = value as { type?: unknown };
  if (type === 'save') {
    const { server, label, token } = value as Partial<Record<keyof SaveRequest, unknown>>;
    return typeof server === 'string' && typeof label === 'string' && typeof token === 'string';
  }
  return type === 'status' || type === 'flush' || type === 'check-update' || type === 'diagnostic-start' || type === 'diagnostic-send' || type === 'diagnostic-status';
}
