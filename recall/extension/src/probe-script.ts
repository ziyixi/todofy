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
    void chrome.runtime.sendMessage({ type: 'page-visibility', documentId: state.documentId, visible, at: Date.now() }).catch(() => undefined);
  };
  document.addEventListener('visibilitychange', () => { report(document.visibilityState === 'visible'); });
  window.addEventListener('pagehide', () => { report(false); });
  window.addEventListener('pageshow', () => { report(document.visibilityState === 'visible'); });
}

export const result = { documentId: globalThis.recallPageProbe.documentId, visible: globalThis.recallPageProbe.visible && document.visibilityState === 'visible', url: location.href };
