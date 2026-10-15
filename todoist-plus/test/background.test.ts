import { beforeEach, expect, it, vi } from "vitest";
import {
  PLANNING_PROTOCOL,
  type BackgroundMessage,
  type Result,
} from "../src/messages";
import { registerBackground } from "../src/background";

const mocks = vi.hoisted(() => {
  const local = new Map<string, unknown>();
  return {
    addListener: vi.fn(),
    local,
    get: vi.fn(async (key: string) => ({ [key]: local.get(key) })),
    set: vi.fn(async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) local.set(key, value);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of [keys].flat()) local.delete(key);
    }),
    load: vi.fn(),
    readPlan: vi.fn(),
  };
});
vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic",
      getURL: () => "chrome-extension://synthetic/",
      onMessage: { addListener: mocks.addListener },
    },
    storage: {
      local: {
        setAccessLevel: vi.fn(),
        get: mocks.get,
        set: mocks.set,
        remove: mocks.remove,
      },
      session: { get: vi.fn(async () => ({})), set: vi.fn(), remove: vi.fn() },
    },
  },
}));
vi.mock("../src/api", () => ({
  createApi: () => ({ load: mocks.load, readPlan: mocks.readPlan }),
  publicError: (error: unknown) =>
    error instanceof Error ? error.message : "Synthetic failure",
  validOrigin: (origin: string) => origin,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.local.clear();
  registerBackground();
});
function send(message: BackgroundMessage | Record<string, unknown>) {
  const receive = mocks.addListener.mock.calls[0]![0];
  return new Promise<Result>((resolve) =>
    receive(
      message,
      { id: "synthetic", url: "https://app.todoist.com/app/today" },
      resolve,
    ),
  );
}

it("rejects an old planning script before reading its connection or writing tasks", async () => {
  const result = await send({
    kind: "action",
    method: "updateTask",
    args: [{ id: "synthetic" }, { stage: "committed" }],
  });
  expect(result).toEqual({
    ok: false,
    error: "Extension updated. Reload Todoist to continue.",
  });
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.load).not.toHaveBeenCalled();
});

it("caches only replaced IDs from ReadPlan and serves them to the next page without a request", async () => {
  mocks.local.set("connection", {
    apiOrigin: "https://api.example.test",
    token: "synthetic",
  });
  mocks.readPlan.mockResolvedValue({
    configured: true,
    hiddenFilterIds: ["f1"],
    managedLabels: [
      { role: "committed", id: "l1", label: "committed" },
      { role: "office", id: "l2", label: "office" },
    ],
    availableLabels: [{ id: "l1", label: "committed" }],
    timezone: "UTC",
  });
  expect(
    await send({
      kind: "action",
      protocol: PLANNING_PROTOCOL,
      method: "readPlan",
      args: [],
    }),
  ).toMatchObject({ ok: true });
  const cached = {
    configured: true,
    hiddenFilterIds: ["f1"],
    labelIds: ["l1"],
  };
  expect(mocks.local.get("planConfig")).toEqual(cached);
  mocks.readPlan.mockClear();
  expect(await send({ kind: "planConfig" })).toEqual({
    ok: true,
    value: cached,
  });
  expect(mocks.readPlan).not.toHaveBeenCalled();
});

it("forgets the cached configuration when the connection is revoked", async () => {
  mocks.local.set("connection", {
    apiOrigin: "https://api.example.test",
    token: "synthetic",
  });
  mocks.local.set("planConfig", {
    configured: true,
    hiddenFilterIds: ["f1"],
    labelIds: ["l1"],
  });
  mocks.readPlan.mockRejectedValue(
    new Error("Connection expired or revoked. Open connection settings."),
  );
  expect(
    await send({
      kind: "action",
      protocol: PLANNING_PROTOCOL,
      method: "readPlan",
      args: [],
    }),
  ).toMatchObject({ ok: false });
  await vi.waitFor(() => expect(mocks.local.has("planConfig")).toBe(false));
  expect(await send({ kind: "planConfig" })).toEqual({ ok: true, value: null });
});
