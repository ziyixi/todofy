import { beforeEach, expect, it, vi } from "vitest";
import type { Result } from "../src/messages";
import { registerBackground } from "../src/background";

const mocks = vi.hoisted(() => ({
  addListener: vi.fn(),
  get: vi.fn(),
  load: vi.fn(),
}));
vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic",
      getURL: () => "chrome-extension://synthetic/",
      onMessage: { addListener: mocks.addListener },
    },
    storage: { local: { setAccessLevel: vi.fn(), get: mocks.get } },
  },
}));
vi.mock("../src/api", () => ({
  createApi: () => ({ load: mocks.load }),
  publicError: () => "Synthetic failure",
  validOrigin: (origin: string) => origin,
}));

beforeEach(() => {
  vi.clearAllMocks();
  registerBackground();
});

it("rejects an old planning script before reading its connection or writing tasks", async () => {
  const receive = mocks.addListener.mock.calls[0]![0];
  const result = await new Promise<Result>((resolve) => {
    receive(
      {
        kind: "action",
        method: "updateTask",
        args: [{ id: "synthetic" }, { stage: "committed" }],
      },
      { id: "synthetic", url: "https://app.todoist.com/app/today" },
      resolve,
    );
  });
  expect(result).toEqual({
    ok: false,
    error: "Extension updated. Reload Todoist to continue.",
  });
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.load).not.toHaveBeenCalled();
});
