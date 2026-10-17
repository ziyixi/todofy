import { beforeEach, expect, it, vi } from "vitest";
import {
  PLANNING_PROTOCOL,
  type BackgroundMessage,
  type Result,
} from "../src/messages";
import { registerBackground } from "../src/background";
import type { KnownTaskStore } from "../src/api";
import type { PageStatus } from "../src/page-status";
import { DEFAULT_PLAN_VIEW } from "../src/plan-view-state";

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
    setWeeklyBet: vi.fn(),
    deleteMail: vi.fn(),
    sessionSet: vi.fn(),
    store: undefined as KnownTaskStore | undefined,
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
      session: {
        get: vi.fn(async () => ({})),
        set: mocks.sessionSet,
        remove: vi.fn(),
      },
    },
  },
}));
vi.mock("../src/api", () => ({
  createApi: (_connection: unknown, _fetch: unknown, store: KnownTaskStore) => {
    mocks.store = store;
    return {
      load: mocks.load,
      readPlan: mocks.readPlan,
      setWeeklyBet: mocks.setWeeklyBet,
      deleteMail: mocks.deleteMail,
    };
  },
  publicError: (error: unknown) =>
    error instanceof Error ? error.message : "Synthetic failure",
  validOrigin: (origin: string) => origin,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.local.clear();
  registerBackground();
});
function send(
  message: BackgroundMessage | Record<string, unknown>,
  url = "https://app.todoist.com/app/today",
) {
  const receive = mocks.addListener.mock.calls[0]![0];
  return new Promise<Result>((resolve) =>
    receive(message, { id: "synthetic", url }, resolve),
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
  // A page left open from before protocol 6 sends the mail methods' old arguments.
  expect(
    await send({
      kind: "action",
      protocol: 5,
      method: "updateMailSettings",
      args: [[], "synthetic-project", "mail-0"],
    }),
  ).toEqual({
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
    inboxProjectId: "p1",
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
    hiddenProjectIds: ["p1"],
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

it("does not store a read that finishes after a disconnect", async () => {
  mocks.local.set("connection", {
    apiOrigin: "https://api.example.test",
    token: "synthetic",
  });
  let finish!: (plan: unknown) => void;
  mocks.readPlan.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const read = send({
    kind: "action",
    protocol: PLANNING_PROTOCOL,
    method: "readPlan",
    args: [],
  });
  await vi.waitFor(() => expect(mocks.readPlan).toHaveBeenCalledOnce());
  expect(
    await send(
      { kind: "disconnect" },
      "chrome-extension://synthetic/options.html",
    ),
  ).toEqual({ ok: true, value: null });
  finish({
    configured: true,
    hiddenFilterIds: ["f1"],
    managedLabels: [{ role: "committed", id: "l1", label: "committed" }],
  });
  expect(await read).toMatchObject({ ok: true });
  // The old client's FlowDay IDs stay out of session storage too.
  await mocks.store!.write(["synthetic-task"]);
  expect(mocks.local.has("planConfig")).toBe(false);
  expect(mocks.sessionSet).not.toHaveBeenCalled();
});

it("keeps only a closed-set page status from Todoist and shows it to the options page", async () => {
  const status: PageStatus = {
    language: "en",
    off: { taskTools: "detailMain" },
  };
  expect(await send({ kind: "reportPage", status })).toEqual({
    ok: true,
    value: null,
  });
  expect(mocks.local.get("pageStatus")).toEqual(status);
  const refused = await send({
    kind: "reportPage",
    status: { ...status, title: "Synthetic task title" } as PageStatus,
  });
  expect(refused.ok).toBe(false);
  expect(mocks.local.get("pageStatus")).toEqual(status);
  // Only the options page reads it, and only Todoist pages report it.
  expect((await send({ kind: "pageStatus" })).ok).toBe(false);
  const options = "chrome-extension://synthetic/options.html";
  expect((await send({ kind: "reportPage", status }, options)).ok).toBe(false);
  expect(await send({ kind: "pageStatus" }, options)).toEqual({
    ok: true,
    value: status,
  });
});

it("keeps only Other views' open state, for Todoist pages, and forgets it on disconnect", async () => {
  expect(await send({ kind: "otherViews" })).toEqual({
    ok: true,
    value: false,
  });
  expect(await send({ kind: "otherViews", open: true })).toEqual({
    ok: true,
    value: null,
  });
  expect(mocks.local.get("otherViewsOpen")).toBe(true);
  expect(await send({ kind: "otherViews" })).toEqual({ ok: true, value: true });
  // A non-boolean is refused, not stored, and only Todoist pages may ask.
  expect(
    await send({ kind: "otherViews", open: "yes" } as Record<string, unknown>),
  ).toMatchObject({
    ok: false,
  });
  expect(mocks.local.get("otherViewsOpen")).toBe(true);
  expect(
    await send(
      { kind: "otherViews" },
      "chrome-extension://synthetic/options.html",
    ),
  ).toMatchObject({ ok: false });
  await send(
    { kind: "disconnect" },
    "chrome-extension://synthetic/options.html",
  );
  expect(mocks.local.has("otherViewsOpen")).toBe(false);
});

it("keeps Plan's view for Todoist pages as merged patches, and forgets it on disconnect", async () => {
  expect(await send({ kind: "planView" })).toEqual({ ok: true, value: null });
  const review = { week: "2026-10-12", open: true, lines: [1], kept: [] };
  expect(await send({ kind: "planView", patch: { review } })).toEqual({
    ok: true,
    value: { ...DEFAULT_PLAN_VIEW, review },
  });
  // Two tabs change two fields at once: neither loses the other's.
  const [week, folded] = await Promise.all([
    send({ kind: "planView", patch: { tab: "week" } }),
    send({ kind: "planView", patch: { committedFolded: true } }),
  ]);
  expect([week.ok, folded.ok]).toEqual([true, true]);
  const stored = {
    ...DEFAULT_PLAN_VIEW,
    tab: "week",
    review,
    committedFolded: true,
  };
  expect(mocks.local.get("planView")).toEqual(stored);
  expect(await send({ kind: "planView" })).toEqual({
    ok: true,
    value: stored,
  });
  // Anything outside the closed shape is refused and nothing is stored.
  for (const patch of [
    { tab: "focus" },
    { review: { ...review, kept: ["Synthetic task title"] } },
    { title: "Synthetic task title" },
  ])
    expect(
      await send({ kind: "planView", patch } as Record<string, unknown>),
    ).toMatchObject({ ok: false, error: "Unsupported extension operation." });
  expect(mocks.local.get("planView")).toEqual(stored);
  // Only Todoist pages read or write it.
  const options = "chrome-extension://synthetic/options.html";
  expect(await send({ kind: "planView" }, options)).toMatchObject({
    ok: false,
  });
  expect(
    await send({ kind: "planView", patch: { tab: "review" } }, options),
  ).toMatchObject({ ok: false });
  expect(mocks.local.get("planView")).toEqual(stored);
  await send({ kind: "disconnect" }, options);
  expect(mocks.local.has("planView")).toBe(false);
});

it("passes a refused Bet to the page as a value, which an Error could not carry", async () => {
  const { BetNotSaved } = await import("../src/bets");
  mocks.local.set("connection", {
    apiOrigin: "https://api.example.test",
    token: "synthetic",
  });
  const message = {
    kind: "action",
    protocol: PLANNING_PROTOCOL,
    method: "setWeeklyBet",
    args: [{ weekStart: "2026-10-12", area: "work", text: "Goal", etag: "" }],
  } as const;
  mocks.setWeeklyBet.mockRejectedValueOnce(new BetNotSaved("changed"));
  expect(await send(message)).toEqual({
    ok: true,
    value: { notSaved: "changed" },
  });
  mocks.setWeeklyBet.mockRejectedValueOnce(new Error("Synthetic outage"));
  expect(await send(message)).toEqual({
    ok: false,
    error: "Synthetic outage",
  });
  // The Bet text never reaches the ID-only configuration cache.
  expect(mocks.local.has("planConfig")).toBe(false);
});

it("passes a Mailbox action to Todofy with its arguments and answers its result", async () => {
  mocks.local.set("connection", {
    apiOrigin: "https://api.example.test",
    token: "synthetic",
  });
  mocks.deleteMail.mockResolvedValue({
    deletedTaskIds: ["m1"],
    keptTaskIds: [],
  });
  expect(
    await send({
      kind: "action",
      protocol: PLANNING_PROTOCOL,
      method: "deleteMail",
      args: [["m1"], "11111111-1111-4111-8111-111111111111"],
    }),
  ).toEqual({ ok: true, value: { deletedTaskIds: ["m1"], keptTaskIds: [] } });
  expect(mocks.deleteMail).toHaveBeenCalledWith(
    ["m1"],
    "11111111-1111-4111-8111-111111111111",
  );
});
