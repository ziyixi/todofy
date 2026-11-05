import { configure } from "@testing-library/react";
import { vi } from "vitest";

// A cut title's bubble repeats it for sight only (aria-hidden): text queries find the title once.
configure({ defaultIgnore: "script, style, .planning-full-title-bubble" });
// jsdom has no layout. Geometry is covered by the consumer's packaged browser suite.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

// Node's own localStorage (unavailable without --localstorage-file) shadows jsdom's. Replaced
// without reading it, which would print Node's warning.
class MemoryStorage implements Storage {
  #items = new Map<string, string>();
  get length() {
    return this.#items.size;
  }
  clear() {
    this.#items.clear();
  }
  getItem(key: string) {
    return this.#items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.#items.delete(key);
  }
  setItem(key: string, value: string) {
    this.#items.set(key, String(value));
  }
}
Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
}

/**
 * Document Picture-in-Picture window stand-in whose document is an iframe's,
 * whose timers are its own, and whose first close() dispatches pagehide.
 */
export function fakePipWindow() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const events = new EventTarget();
  const timers = new Map<number, () => void>();
  let next = 0;
  const pip = {
    closed: false,
    document: frame.contentDocument!,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    setTimeout: vi.fn((callback: () => void) => {
      timers.set(++next, callback);
      return next;
    }),
    clearTimeout: vi.fn((id: number) => timers.delete(id)),
    close() {
      if (pip.closed) return;
      pip.closed = true;
      events.dispatchEvent(new Event("pagehide"));
    },
    /** Runs the timers it holds now, as its own clock would. */
    tick() {
      const due = [...timers.values()];
      timers.clear();
      due.forEach((callback) => callback());
    },
  };
  return pip;
}
export type FakePipWindow = ReturnType<typeof fakePipWindow>;

/** Chrome's Document Picture-in-Picture API: each request opens a new window. */
export function stubPictureInPicture() {
  const windows: FakePipWindow[] = [];
  const requestWindow = vi.fn(async () => {
    windows.push(fakePipWindow());
    return windows.at(-1)!;
  });
  Object.defineProperty(window, "documentPictureInPicture", {
    value: { requestWindow },
    configurable: true,
  });
  return { windows, requestWindow };
}
