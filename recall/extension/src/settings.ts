/**
 * The owner's settings (../../docs/design.md §3.8-§3.9), set in the options page: recall's origin, the ingest token
 * (kept in the IndexedDB, never shown again) and the device's label. Also the denylist in force (the shared lists, the
 * owner's patterns from recall's last answer, recall's own hosts) and the status the options page shows.
 */
import { compilePatterns, RECALL_HOST } from '../../shared/denylist.ts';
import type { Context } from './context.ts';
import { browserFeatures } from './browser.ts';
import { countHeld, countItems, countVisits, getToken, setToken } from './db.ts';
import { LABEL_MAX_CHARS } from './limits.ts';
import type { SaveAnswer, SavePhase, SaveProgress, SaveRequest, Status } from './messages.ts';
import type { Denylist } from './page.ts';
import { captureStatus, focusState, getDevice, lastError, mirror, ownerDenylist, setDevice, uploadState, type Device } from './store.ts';

/** An ingest token as recall's 设置 → 插件口令 makes it: 32 random bytes in base64url after the prefix. */
const INGEST_TOKEN = /^recall_ingest_[A-Za-z0-9_-]{43}$/;
const EXPORT_TOKEN = /^recall_export_/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** recall's origin from what the owner typed: https (http on loopback only), no path, query, fragment or user. */
export function parseServer(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!secure || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

/** The ingest token from what the owner pasted, or why it is not one. */
export function parseToken(text: string): { readonly token: string } | { readonly error: 'token_export' | 'token_invalid' } {
  const token = text.trim();
  if (INGEST_TOKEN.test(token)) return { token };
  return { error: EXPORT_TOKEN.test(token) ? 'token_export' : 'token_invalid' };
}

/** A device label: trimmed, 1 to 64 characters. */
export function parseLabel(text: string): string | null {
  const label = text.trim();
  const length = Array.from(label).length;
  return length >= 1 && length <= LABEL_MAX_CHARS ? label : null;
}

/** The hosts recall never records: its public host and the server the owner set. */
export function ownHosts(server: string): string[] {
  const host = new URL(server).hostname;
  return host === RECALL_HOST ? [RECALL_HOST] : [RECALL_HOST, host];
}

/** The denylist in force: the owner's two lists from recall's last answer and recall's own hosts. */
export async function currentDenylist(ctx: Context): Promise<Denylist> {
  const [owner, device] = await Promise.all([ownerDenylist.get(ctx.chrome), getDevice(ctx.chrome, ctx.uuid)]);
  return { patterns: { siteOnly: compilePatterns(owner.siteOnly), noText: compilePatterns(owner.patterns) }, ownHosts: ownHosts(device.server) };
}

// Transient diagnostics contain no settings or token values and never touch browser storage.
let savingPhase: SavePhase = 'idle';
export const saveProgress = (): SaveProgress => ({ phase: savingPhase });

/** Saves the options. A new token or server lifts a refused token's stop and the backoff, so the next flush uploads. */
export async function saveSettings(ctx: Context, request: SaveRequest): Promise<SaveAnswer> {
  const server = parseServer(request.server);
  if (server === null) return { ok: false, error: 'server_invalid' };
  const label = parseLabel(request.label);
  if (label === null) return { ok: false, error: 'label_invalid' };
  let token: string | null = null;
  if (request.token.trim() !== '') {
    const parsed = parseToken(request.token);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    token = parsed.token;
  }
  try {
    savingPhase = 'device';
    const device = await getDevice(ctx.chrome, ctx.uuid);
    const next: Device = { ...device, server, label };
    await setDevice(ctx.chrome, next);
    if (token !== null) {
      savingPhase = 'token';
      await setToken(ctx.db, token);
    }
    if (token !== null || server !== device.server) {
      savingPhase = 'upload-state';
      const upload = await uploadState.get(ctx.chrome);
      await uploadState.set(ctx.chrome, { ...upload, tokenRefused: false, nextAttemptAt: 0, backoffMs: 0 });
    }
    return { ok: true };
  } finally {
    savingPhase = 'idle';
  }
}

/** What the options page shows. */
export async function status(ctx: Context): Promise<Status> {
  const now = ctx.now();
  const [device, upload, error, token, queued, held, localVisitCount, savedFocus] = await Promise.all([
    getDevice(ctx.chrome, ctx.uuid),
    uploadState.get(ctx.chrome),
    lastError.get(ctx.chrome),
    getToken(ctx.db),
    countItems(ctx.db),
    countHeld(ctx.db, now),
    countVisits(ctx.db),
    mirror.get(ctx.chrome),
  ]);
  const manifest = ctx.chrome.runtime.getManifest();
  const features = browserFeatures(ctx.chrome);
  const focus = await focusState.get(ctx.chrome);
  return {
    now,
    mobile: ctx.mobile === true,
    capture: await captureStatus.get(ctx.chrome),
    focused: focus?.open !== null && focus?.open !== undefined,
    lastFocusCheckAt: savedFocus.lastBeat,
    localVisitCount,
    capabilities: { script: features.scripting !== undefined || features.tabs.executeScript !== undefined, screenshot: features.tabs.captureVisibleTab !== undefined },
    version: manifest.version,
    versionName: manifest.version_name ?? '',
    deviceId: device.id,
    label: device.label,
    server: device.server,
    tokenSet: token !== '',
    queued,
    held,
    upload,
    lastError: error,
  };
}
