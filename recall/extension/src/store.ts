/**
 * The small records the service worker keeps in chrome.storage, since it sleeps after 30 s without events and loses
 * its globals (../../docs/design.md §3.2). storage.session lives while the extension is loaded (Chrome clears it when
 * the browser restarts or the extension reloads); storage.local survives both, and the IndexedDB (db.ts) holds the rest.
 *
 * | Area | Key | What |
 * | --- | --- | --- |
 * | session | `focus` | the open focus span, the focused window, the idle state |
 * | local | `mirror` | the open span again, with `lastBeat`: the last moment the extension knew it held |
 * | local | `device` | the device ID, the owner's label and the server's origin |
 * | local | `upload` | the uploads' state: the last success, the backoff, the batch size, a refused token |
 * | local | `denylist` | the owner's two lists of patterns and their etag, from recall's last answer |
 * | local | `error` | the last error code and its time, reported with every upload for a day |
 * | local | `reloaded` | the version the worker last reloaded for (update.ts) |
 */
import { RECALL_HOST } from '../../shared/denylist.ts';
import { BATCH_MAX_ITEMS, DEFAULT_LABEL } from './limits.ts';

export type IdleState = `${chrome.idle.IdleState}`;

/** The focus as it is now: at most one open span, on the active tab of the focused window. */
export interface Span {
  readonly visitId: string;
  readonly tabId: number;
  readonly documentId: string;
  readonly start: number;
}

export interface FocusState {
  readonly open: Span | null;
  /** The focused window; chrome.windows.WINDOW_ID_NONE while another app is in front. */
  readonly windowId: number;
  readonly idle: IdleState;
}

export interface Mirror {
  readonly open: Span | null;
  readonly lastBeat: number;
}

export interface Device {
  /** A UUID made at install. */
  readonly id: string;
  readonly label: string;
  /** recall's origin (`https://recall.ziyixi.science`). */
  readonly server: string;
}

export interface UploadState {
  /** The last upload recall answered 200 (a heartbeat too); 0 before the first. */
  readonly lastUploadAt: number;
  /** No upload before this (a backoff or a Retry-After). */
  readonly nextAttemptAt: number;
  /** The current backoff; 0 while uploads work. */
  readonly backoffMs: number;
  /** When the uploads began to fail (a network error, an unexpected answer); 0 while they work. */
  readonly failingSince: number;
  /** Items per batch: halved by a 413, doubled back by each success. */
  readonly batchLimit: number;
  /** recall refused the token (401): nothing is uploaded until the owner saves another. */
  readonly tokenRefused: boolean;
  /** Items recall refused since the install (they are lost; recall counts them by reason too). */
  readonly rejectedCount: number;
}

export interface OwnerDenylist {
  /** The no-text patterns. */
  readonly patterns: readonly string[];
  /** The site-only patterns. */
  readonly siteOnly: readonly string[];
  readonly etag: string;
}

export interface LastError {
  /** A code (`capture_failed`, `upload_failed`, `outbox_full`). */
  readonly code: string;
  readonly at: number;
}

export const DEFAULT_SERVER = `https://${RECALL_HOST}`;

export const INITIAL_UPLOAD: UploadState = {
  lastUploadAt: 0,
  nextAttemptAt: 0,
  backoffMs: 0,
  failingSince: 0,
  batchLimit: BATCH_MAX_ITEMS,
  tokenRefused: false,
  rejectedCount: 0,
};

async function read<T>(area: chrome.storage.StorageArea, key: string): Promise<T | undefined> {
  const items = await area.get(key);
  return items[key] as T | undefined;
}

async function write(area: chrome.storage.StorageArea, key: string, value: unknown): Promise<void> {
  await area.set({ [key]: value });
}

// MV2 has no storage.session. Keep the current background session in memory; the existing local mirror
// closes its last span when a nonpersistent background page is recreated.
const mobileFocus = new WeakMap<typeof chrome, FocusState>();
export const focusState = {
  get: (api: typeof chrome): Promise<FocusState | undefined> => (api.storage.session as chrome.storage.StorageArea | undefined) === undefined ? Promise.resolve(mobileFocus.get(api)) : read<FocusState>(api.storage.session, 'focus'),
  set: (api: typeof chrome, state: FocusState): Promise<void> => {
    if ((api.storage.session as chrome.storage.StorageArea | undefined) !== undefined) return write(api.storage.session, 'focus', state);
    mobileFocus.set(api, state);
    return Promise.resolve();
  },
};

export interface CaptureStatus {
  readonly at: number;
  readonly text: 'saved' | 'empty' | 'failed' | 'excluded' | 'unchanged';
  readonly screenshot: 'webp' | 'jpeg' | 'failed' | 'excluded' | 'none';
}
export const captureStatus = {
  get: async (api: typeof chrome): Promise<CaptureStatus | null> => (await read<CaptureStatus>(api.storage.local, 'capture_status')) ?? null,
  set: (api: typeof chrome, value: CaptureStatus) => write(api.storage.local, 'capture_status', value),
};

export const mirror = {
  get: async (api: typeof chrome): Promise<Mirror> => (await read<Mirror>(api.storage.local, 'mirror')) ?? { open: null, lastBeat: 0 },
  set: (api: typeof chrome, value: Mirror) => write(api.storage.local, 'mirror', value),
};

export const uploadState = {
  get: async (api: typeof chrome): Promise<UploadState> => ({ ...INITIAL_UPLOAD, ...(await read<Partial<UploadState>>(api.storage.local, 'upload')) }),
  set: (api: typeof chrome, value: UploadState) => write(api.storage.local, 'upload', value),
};

export const ownerDenylist = {
  get: async (api: typeof chrome): Promise<OwnerDenylist> => ({ patterns: [], siteOnly: [], etag: '', ...(await read<Partial<OwnerDenylist>>(api.storage.local, 'denylist')) }),
  set: (api: typeof chrome, value: OwnerDenylist) => write(api.storage.local, 'denylist', value),
};

/** The version the worker last reloaded into: the tick does not reload twice for the same one. */
export const reloadedFor = {
  get: async (api: typeof chrome): Promise<string> => (await read<string>(api.storage.local, 'reloaded')) ?? '',
  set: (api: typeof chrome, version: string) => write(api.storage.local, 'reloaded', version),
};

export const lastError = {
  get: async (api: typeof chrome): Promise<LastError | null> => (await read<LastError>(api.storage.local, 'error')) ?? null,
  set: (api: typeof chrome, code: string, at: number) => write(api.storage.local, 'error', { code, at } satisfies LastError),
};

/**
 * The device, made on first use (a UUID, the default label and recall's public origin). The service worker makes it
 * before its first handler runs (sw.ts), so two handlers never make two.
 */
export async function getDevice(api: typeof chrome, uuid: () => string, defaultLabel = DEFAULT_LABEL): Promise<Device> {
  const stored = await read<Partial<Device>>(api.storage.local, 'device');
  if (typeof stored?.id === 'string' && stored.id !== '') {
    return { id: stored.id, label: stored.label ?? DEFAULT_LABEL, server: stored.server ?? DEFAULT_SERVER };
  }
  const device: Device = { id: uuid(), label: defaultLabel, server: DEFAULT_SERVER };
  await write(api.storage.local, 'device', device);
  return device;
}

export async function setDevice(api: typeof chrome, device: Device): Promise<void> {
  await write(api.storage.local, 'device', device);
}
