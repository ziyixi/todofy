/**
 * The messages between the options page and the service worker (chrome.runtime.sendMessage, from the extension's own
 * pages only): the status, saving the settings, 立即上传 and 检查更新.
 */
import type { CaptureStatus, LastError, UploadState } from './store.ts';

export interface SaveRequest {
  readonly server: string;
  readonly label: string;
  /** A new ingest token, or '' to keep the saved one. */
  readonly token: string;
}

export type Request =
  | { readonly type: 'status' }
  | { readonly type: 'save-progress' }
  | ({ readonly type: 'save' } & SaveRequest)
  | { readonly type: 'flush' }
  | { readonly type: 'check-update' };

export type SaveAnswer = { readonly ok: true } | { readonly ok: false; readonly error: 'server_invalid' | 'label_invalid' | 'token_invalid' | 'token_export' };

export type SavePhase = 'idle' | 'device' | 'token' | 'upload-state';
export interface SaveProgress { readonly phase: SavePhase }

export interface Status {
  readonly now: number;
  readonly mobile?: boolean;
  readonly capture?: CaptureStatus | null;
  readonly capabilities?: { readonly script: boolean; readonly screenshot: boolean };
  readonly focused?: boolean;
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
  return type === 'status' || type === 'save-progress' || type === 'flush' || type === 'check-update';
}
