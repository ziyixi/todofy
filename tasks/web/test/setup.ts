import { vi } from "vitest";

// jsdom has no layout. Real drag geometry is checked by the packaged Chromium/D1 journeys.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
