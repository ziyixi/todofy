/** Dynamically injected into an allowed top frame. Its token survives repeated probes, not navigation. */
import { readPage } from './page-text.ts';

declare const RECALL_ORION: boolean;
declare const RECALL_BUILD: string;

export interface ProbeState {
  readonly documentId: string;
  visible: boolean;
  listener?: Parameters<typeof chrome.runtime.onMessage.addListener>[0];
}

declare global {
  var recallPageProbe: ProbeState | undefined;
}

const topFrame = !RECALL_ORION || window === window.top;
if (topFrame && globalThis.recallPageProbe === undefined) {
  const state: ProbeState = { documentId: crypto.randomUUID(), visible: document.visibilityState === 'visible' };
  globalThis.recallPageProbe = state;
  const report = (visible: boolean) => {
    state.visible = visible;
    try {
      // The MV2 callback consumes a closed response port; sendMessage itself returns no Promise.
      chrome.runtime.sendMessage({ type: 'page-visibility', documentId: state.documentId, visible, at: Date.now() }, () => { if (chrome.runtime.lastError !== undefined) return; });
    } catch {
      // Navigation or an extension update can invalidate this content-script context.
    }
  };
  document.addEventListener('visibilitychange', () => { report(document.visibilityState === 'visible'); });
  window.addEventListener('pagehide', () => { report(false); });
  window.addEventListener('pageshow', () => { report(document.visibilityState === 'visible'); });
}

function probe() {
  const state = globalThis.recallPageProbe;
  return state === undefined ? undefined : { documentId: state.documentId, visible: state.visible && document.visibilityState === 'visible', url: location.href };
}

if (RECALL_ORION && topFrame && globalThis.recallPageProbe !== undefined) {
  const state = globalThis.recallPageProbe;
  // Replace the listener on reinjection so it uses this build, while preserving the document token.
  if (state.listener !== undefined) chrome.runtime.onMessage.removeListener(state.listener);
  state.listener = (message: unknown, sender, sendResponse) => {
    // tabs.sendMessage targets this extension; native Orion omits the optional sender ID.
    if (sender.id !== undefined && sender.id !== chrome.runtime.id) return false;
    if (typeof message !== 'object' || message === null || !('type' in message)) return false;
    if (message.type === 'recall-probe') sendResponse(probe());
    if (message.type === 'recall-capture-current') {
      if (
        !('expectedDocumentId' in message) || message.expectedDocumentId !== state.documentId ||
        !('url' in message) || message.url !== location.href ||
        !('build' in message) || message.build !== RECALL_BUILD ||
        !state.visible || document.visibilityState !== 'visible'
      ) {
        sendResponse(undefined);
        return false;
      }
      sendResponse(readPage(document, RECALL_BUILD));
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(state.listener);
}

export const result = probe();
