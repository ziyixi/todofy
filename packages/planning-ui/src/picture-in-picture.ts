// The Focus mini timer's window: Document Picture-in-Picture (Chrome 116+), which floats above other windows,
// closes with its opener and cannot be navigated. TypeScript's DOM library does not declare it yet.
import css from "./mini-timer.css?inline";
import { words } from "./i18n";
import type { Language } from "./model";

declare global {
  interface DocumentPictureInPicture extends EventTarget {
    /** Opens the page's one window, closing an earlier one; needs a user gesture. */
    requestWindow(options?: {
      width?: number;
      height?: number;
    }): Promise<Window>;
  }
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

/** An open mini timer: its window, and the element React renders into. */
export interface MiniWindow {
  window: Window;
  container: HTMLElement;
}

/**
 * The tokens mini-timer.css reads. They are copied from the opener's computed style, so the host's
 * overrides (Tasks sets its own --plus-accent) carry over without copying the app's stylesheets.
 */
const TOKENS = [
  "--plus-bg",
  "--plus-text",
  "--plus-muted",
  "--plus-line",
  "--plus-accent",
  "--plus-area-work",
  "--plus-area-personal",
  "--plus-warning",
  "--plus-danger",
];

export function canOpenMiniWindow(): boolean {
  return "documentPictureInPicture" in window;
}

/**
 * Opens the mini timer's window at 320 × 120 (later Chrome reuses the size and place the owner left it at),
 * with its stylesheet and `source`'s tokens and font. Call it from a click: without a user gesture, or when
 * Chrome refuses, there is no window and the answer is undefined.
 */
export async function openMiniWindow(
  source: Element,
  language: Language,
): Promise<MiniWindow | undefined> {
  let pip: Window;
  try {
    pip = await window.documentPictureInPicture!.requestWindow({
      width: 320,
      height: 120,
    });
  } catch {
    return undefined;
  }
  const page = pip.document;
  const style = page.createElement("style");
  style.textContent = css;
  page.head.append(style);
  const computed = getComputedStyle(source);
  const root = page.documentElement;
  for (const token of TOKENS)
    root.style.setProperty(token, computed.getPropertyValue(token).trim());
  root.style.fontFamily = computed.fontFamily;
  root.lang = language;
  page.title = words(language).focus;
  const container = page.createElement("div");
  page.body.append(container);
  return { window: pip, container };
}
