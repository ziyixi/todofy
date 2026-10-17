import { vi } from "vitest";
// jsdom has no layout. Geometry is covered by the consumer's packaged browser suite.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
