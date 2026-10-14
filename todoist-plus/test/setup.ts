import { vi } from "vitest";

// jsdom has no layout; pointer geometry is checked in the packaged browser tests.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
