/** Dynamically injected into an allowed top frame. Its token survives repeated probes, not navigation. */
export interface ProbeState {
  readonly documentId: string;
  visible: boolean;
}

declare global {
  var recallPageProbe: ProbeState | undefined;
}

if (globalThis.recallPageProbe === undefined) {
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

export const result = { documentId: globalThis.recallPageProbe.documentId, visible: globalThis.recallPageProbe.visible && document.visibilityState === 'visible', url: location.href };
