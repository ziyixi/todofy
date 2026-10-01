import { create } from "zustand";

interface PopOutState {
  pipWindow: Window | null;
  container: HTMLElement | null;
  open: () => Promise<void>;
  close: () => void;
}

function copyStylesToPipWindow(pipWindow: Window) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const cssText = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      const style = pipWindow.document.createElement("style");
      style.textContent = cssText;
      pipWindow.document.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = pipWindow.document.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        pipWindow.document.head.appendChild(link);
      }
    }
  }
}

export const usePopOutStore = create<PopOutState>()((set, get) => ({
  pipWindow: null,
  container: null,

  open: async () => {
    const existing = get().pipWindow;
    if (existing && !existing.closed) {
      existing.focus();
      return;
    }
    if (typeof window === "undefined" || !("documentPictureInPicture" in window)) {
      return;
    }

    const win = await window.documentPictureInPicture!.requestWindow({
      width: 320,
      height: 240,
    });

    copyStylesToPipWindow(win);

    win.document.documentElement.style.height = "100%";
    win.document.documentElement.style.overflow = "hidden";
    win.document.body.style.margin = "0";
    win.document.body.style.height = "100%";
    win.document.body.style.overflow = "hidden";

    const root = win.document.createElement("div");
    root.className =
      "h-full w-full overflow-hidden font-sans antialiased bg-background text-foreground";
    win.document.body.appendChild(root);

    win.addEventListener("pagehide", () => {
      set({ pipWindow: null, container: null });
    });

    // Best-effort move to the top-left of the screen. The PiP spec doesn't
    // formally guarantee moveTo works on a PiP window, but Chrome currently
    // honors it; if a browser rejects the call we silently keep the default.
    try {
      const left = typeof screen !== "undefined" ? screen.availLeft ?? 0 : 0;
      const top = typeof screen !== "undefined" ? screen.availTop ?? 0 : 0;
      win.moveTo(left, top);
    } catch {
      // ignored — browser disallowed moving the PiP window
    }

    set({ pipWindow: win, container: root });
  },

  close: () => {
    const win = get().pipWindow;
    if (win && !win.closed) win.close();
    set({ pipWindow: null, container: null });
  },
}));
