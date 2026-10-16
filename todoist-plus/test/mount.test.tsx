import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { mountTodoist } from "../src/mount";
import type { PlanConfig } from "../src/model";
import type { PageStatus } from "../src/page-status";

// A synthetic Todoist shell; the real built extension runs in the packaged browser tests.
const state = vi.hoisted(() => ({
  config: undefined as PlanConfig | undefined,
  // Views whose render throws.
  crash: [] as string[],
  // While set, the Other views toggle waits for it (its CSS still loading).
  holdOtherViews: undefined as Promise<void> | undefined,
  readPlan: undefined as Promise<never> | undefined,
  rejectMounts: 0,
  mounted: [] as string[],
  // Other views' saved open state, and what was saved since.
  otherViews: false,
  savedOtherViews: [] as boolean[],
  reports: [] as PageStatus[],
  timers: [] as (() => void)[],
}));
vi.mock("wxt/utils/content-script-ui/shadow-root", () => ({
  createShadowRootUi: async (
    _ctx: unknown,
    options: {
      name: string;
      anchor: Element;
      append: "first" | "last" | "before" | "after";
      onMount: (container: HTMLElement) => unknown;
      onRemove?: (mounted: unknown) => void;
    },
  ) => {
    if (options.name === "todoist-plus-other-views") await state.holdOtherViews;
    if (state.rejectMounts > 0) {
      state.rejectMounts--;
      throw new Error("Synthetic CSS fetch failure");
    }
    const shadowHost = document.createElement(options.name);
    const container = document.createElement("div");
    shadowHost.append(container);
    let mounted: unknown;
    return {
      shadowHost,
      mount() {
        state.mounted.push(options.name);
        const { anchor, append } = options;
        if (append === "first") anchor.prepend(shadowHost);
        else if (append === "before") anchor.before(shadowHost);
        else if (append === "after") anchor.after(shadowHost);
        else anchor.append(shadowHost);
        mounted = options.onMount(container);
      },
      remove() {
        options.onRemove?.(mounted);
        shadowHost.remove();
        mounted = undefined;
      },
    };
  },
}));
vi.mock("../src/client", () => ({
  cachedPlanConfig: async () => state.config,
  extensionActions: {
    readPlan: () => state.readPlan ?? new Promise(() => {}),
  },
  openOptions: () => {},
  readOtherViews: async () => state.otherViews,
  saveOtherViews: (open: boolean) => state.savedOtherViews.push(open),
  reportPage: (status: PageStatus) => state.reports.push(status),
}));
vi.mock("../src/App", () => ({
  App: ({ view }: { view: string }) => {
    if (state.crash.includes(view)) throw new Error("Synthetic render failure");
    return <p className="synthetic-app">{view}</p>;
  },
}));

/** WXT's context, with invalidation driven by the test. */
const contexts: { ctx: ContentScriptContext; invalidate: () => void }[] = [];
function context() {
  let invalid = false;
  const listeners: (() => void)[] = [];
  const ctx = {
    get isInvalid() {
      if (invalid) for (const listener of listeners.splice(0)) listener();
      return invalid;
    },
    onInvalidated(listener: () => void) {
      listeners.push(listener);
      return () => {};
    },
    addEventListener(target: EventTarget, type: string, handler: () => void) {
      target.addEventListener(type, handler);
    },
    // Run by the test, as if the time had passed.
    setTimeout(handler: () => void) {
      state.timers.push(handler);
      return 1;
    },
  };
  const created = {
    ctx: ctx as unknown as ContentScriptContext,
    invalidate: () => (invalid = true),
  };
  contexts.push(created);
  return created;
}

const sidebar = `<aside data-testid="app-sidebar-scrollable-container"><ul id="top-menu"><li class="current"><a href="/app/today">Today</a></li><li><a href="/app/upcoming">Upcoming</a></li></ul><ul id="favorites"><li id="replaced"><a href="/app/filter/committed-f1">Committed</a></li><li id="extra"><a href="/app/filter/waiting-f2">Waiting</a></li></ul></aside>`;
function shell() {
  document.documentElement.lang = "en";
  document.body.innerHTML = `${sidebar}<main id="content"><section id="native">Native list</section></main>`;
}
const visible = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  return Boolean(element && !element.hidden);
};
/** Lets the observer, its frame and the mount promises run. */
async function settle() {
  await act(async () => {
    for (let index = 0; index < 5; index++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function replaceContent() {
  const fresh = document.createElement("main");
  fresh.id = "content";
  fresh.innerHTML = `<section id="native-2">Native list again</section>`;
  document.querySelector("#content")!.replaceWith(fresh);
}

beforeEach(() => {
  // A frame per microtask, so a thousand passes take milliseconds.
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    queueMicrotask(callback);
    return 1;
  });
  Object.assign(state, {
    config: { configured: true, hiddenFilterIds: ["f1"], labelIds: [] },
    crash: [],
    holdOtherViews: undefined,
    readPlan: undefined,
    rejectMounts: 0,
    mounted: [],
    otherViews: false,
    savedOtherViews: [],
    reports: [],
    timers: [],
  });
  history.replaceState(null, "", "/app/today");
  shell();
});
afterEach(() => {
  for (const { ctx, invalidate } of contexts.splice(0)) {
    invalidate();
    void ctx.isInvalid;
  }
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

it("comes back after Todoist re-creates its content and sidebar", async () => {
  history.replaceState(null, "", "/app/today?todoist-plus=plan");
  const { ctx } = context();
  await act(() => mountTodoist(ctx));
  expect(await screen.findByText("plan")).toBeTruthy();
  expect(visible("#native")).toBe(false);

  replaceContent();
  await settle();
  expect(document.querySelector("#content todoist-plus-view")).toBeTruthy();
  expect(await screen.findByText("plan")).toBeTruthy();
  expect(visible("#native-2")).toBe(false);

  document.querySelector("aside")!.outerHTML = sidebar;
  await settle();
  expect(document.querySelectorAll("todoist-plus-navigation")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Focus" })).toBeTruthy();
});

it("shows native favourites again when the container goes away on a native page", async () => {
  const { ctx } = context();
  await act(() => mountTodoist(ctx));
  await settle();
  expect(visible("#replaced")).toBe(false);
  expect(visible("#extra")).toBe(false);
  expect(screen.getByRole("button", { name: /Other views/u })).toBeTruthy();

  document.querySelector("#content")!.remove();
  await settle();
  expect(visible("#replaced")).toBe(true);
  expect(visible("#extra")).toBe(true);
  expect(
    document.querySelector<HTMLElement>("todoist-plus-other-views")!.style
      .display,
  ).toBe("none");
});

it("remembers whether Other views was left open", async () => {
  state.otherViews = true;
  const { ctx } = context();
  await act(() => mountTodoist(ctx));
  await settle();
  const toggle = screen.getByRole("button", { name: /Other views/u });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(visible("#extra")).toBe(true);
  expect(visible("#replaced")).toBe(false);
  fireEvent.click(toggle);
  await settle();
  expect(visible("#extra")).toBe(false);
  expect(state.savedOtherViews).toEqual([false]);
});

it("never hides a Todoist dialog or toast added beside the Plus view", async () => {
  history.replaceState(null, "", "/app/today?todoist-plus=plan");
  const { ctx } = context();
  await act(() => mountTodoist(ctx));
  await screen.findByText("plan");
  document
    .querySelector("#content")!
    .insertAdjacentHTML(
      "beforeend",
      `<div id="dialog" role="dialog"></div><div id="toast" role="status"></div><div id="list-update"></div>`,
    );
  await settle();
  expect(visible("#dialog")).toBe(true);
  expect(visible("#toast")).toBe(true);
  expect(visible("#list-update")).toBe(false);
});

it("mounts on a later pass after a rejected mount", async () => {
  history.replaceState(null, "", "/app/today?todoist-plus=plan");
  state.rejectMounts = 1;
  const { ctx } = context();
  await expect(mountTodoist(ctx)).rejects.toThrow("Synthetic CSS fetch");
  expect(visible("#native")).toBe(true);
  document.body.classList.add("synthetic-change");
  await settle();
  expect(await screen.findByText("plan")).toBeTruthy();
  expect(visible("#native")).toBe(false);
});

it("restores native Todoist once the extension is disabled or reloaded", async () => {
  history.replaceState(null, "", "/app/today?todoist-plus=plan");
  const { ctx, invalidate } = context();
  await act(() => mountTodoist(ctx));
  await screen.findByText("plan");
  invalidate();
  window.dispatchEvent(new Event("focus"));
  expect(visible("#native")).toBe(true);
  expect(visible("#replaced")).toBe(true);
  expect(document.querySelector("todoist-plus-view")).toBeNull();
  expect(document.querySelector("todoist-plus-navigation")).toBeNull();
});

it("turns a render failure into one way back to native Todoist", async () => {
  history.replaceState(null, "", "/app/today?todoist-plus=plan");
  state.crash = ["plan"];
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { ctx } = context();
  await act(() => mountTodoist(ctx));
  const back = await screen.findByRole("button", { name: "Back to Todoist" });
  expect(screen.getByRole("alert").textContent).toBe(
    "Back to Todoist / Reload",
  );
  fireEvent.click(back);
  expect(location.search).toBe("");
  expect(visible("#native")).toBe(true);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("caps re-mounts when an anchor keeps flickering", async () => {
  history.replaceState(null, "", "/app/today?todoist-plus=plan");
  const { ctx } = context();
  await act(() => mountTodoist(ctx));
  await screen.findByText("plan");
  for (let index = 0; index < 12; index++) {
    replaceContent();
    await settle();
  }
  // Ten mounts a minute: the first and nine re-mounts.
  expect(
    state.mounted.filter((name) => name === "todoist-plus-view"),
  ).toHaveLength(10);
  expect(document.querySelector("todoist-plus-view")).toBeNull();
  expect(visible("#native-2")).toBe(true);
});

it("stops and restores Todoist when Plus and the page keep answering each other", async () => {
  history.replaceState(null, "", "/app/today?todoist-plus=plan");
  const { ctx } = context();
  await act(() => mountTodoist(ctx));
  await screen.findByText("plan");
  // A page that re-creates whatever Plus hides: Plus changes the page in every pass.
  const main = document.querySelector("#content")!;
  let rebuilt = 0;
  const rebuild = () => {
    const child = main.querySelector<HTMLElement>(":scope > section[hidden]");
    if (!child || rebuilt > 3000) return;
    rebuilt++;
    const fresh = document.createElement("section");
    fresh.id = "native";
    child.replaceWith(fresh);
  };
  const page = new MutationObserver(rebuild);
  page.observe(main, { subtree: true, attributes: true });
  await act(async () => {
    rebuild();
    for (
      let index = 0;
      index < 50 && document.querySelector("todoist-plus-view");
      index++
    )
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
  page.disconnect();
  expect(rebuilt).toBeGreaterThanOrEqual(1500);
  expect(rebuilt).toBeLessThan(3000);
  expect(document.querySelector("todoist-plus-view")).toBeNull();
  expect(visible("#native")).toBe(true);
  expect(visible("#replaced")).toBe(true);
  expect(state.reports.at(-1)!.off.views).toBe("passLimited");
});

it("never tears down for Todoist's own activity, however long it lasts", async () => {
  const { ctx } = context();
  await act(() => mountTodoist(ctx));
  await settle();
  // A virtualised list swapping a row every frame while scrolling; Plus changes nothing.
  const list = document.querySelector("#native")!;
  await act(async () => {
    for (let index = 0; index < 3000; index++) {
      list.append(document.createElement("div"));
      list.firstElementChild?.remove();
      await new Promise((resolve) => queueMicrotask(() => resolve(null)));
      await new Promise((resolve) => queueMicrotask(() => resolve(null)));
    }
  });
  expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
  expect(visible("#extra")).toBe(false);
  expect(state.reports.at(-1)!.off.views).toBeUndefined();
});

it("reports which enhancement is off and why, in closed keys only", async () => {
  const { ctx } = context();
  const removed = document.querySelector("aside")!;
  removed.remove();
  void mountTodoist(ctx);
  await settle();
  for (const timer of state.timers.splice(0)) timer();
  expect(state.reports.at(-1)).toEqual({
    language: "en",
    off: { views: "sidebar" },
  });
  document.body.prepend(removed);
  await settle();
  expect(state.reports.at(-1)).toEqual({ language: "en", off: {} });

  const open = (html: string, path: string) => {
    history.replaceState(null, "", path);
    document.querySelector("[data-testid=task-details-modal]")?.remove();
    document
      .querySelector("#content")!
      .insertAdjacentHTML(
        "beforeend",
        `<section data-testid="task-details-modal">${html}</section>`,
      );
  };
  const list = `<div data-testid="task-selection-list-container"><div data-item-id="child"></div></div>`;
  open(list, "/app/task/child");
  await settle();
  expect(state.reports.at(-1)!.off.taskTools).toBe("detailMain");
  open(
    `${list}<div data-testid="task-main-content-container"></div>`,
    "/app/task/other",
  );
  await settle();
  expect(state.reports.at(-1)!.off.taskTools).toBe("taskIdMismatch");
  expect(document.querySelector("todoist-plus-task-tools")).toBeNull();
  open(
    `${list}<div data-testid="task-main-content-container"></div>`,
    "/app/task/child",
  );
  await settle();
  expect(document.querySelector("todoist-plus-task-tools")).toBeTruthy();
  expect(state.reports.at(-1)).toEqual({ language: "en", off: {} });
  expect(JSON.stringify(state.reports)).not.toMatch(/child|other|task\//u);
});

it("waits for a background tab to be shown before it reports a missing anchor", async () => {
  // Todoist renders after the content script starts, in a tab that runs no frames yet.
  document.body.innerHTML = "";
  const frames: (() => void)[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.push(callback);
    return 1;
  });
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const { ctx } = context();
  await act(() => mountTodoist(ctx));
  shell();
  await settle();
  for (const timer of state.timers.splice(0)) timer();
  expect(state.reports).toEqual([]);
  // Shown: the first frame mounts Plus, and the re-armed check finds nothing missing.
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await act(async () => {
    for (const frame of frames.splice(0)) frame();
  });
  await settle();
  for (const timer of state.timers.splice(0)) timer();
  expect(document.querySelector("todoist-plus-navigation")).toBeTruthy();
  expect(state.reports.at(-1)).toEqual({ language: "en", off: {} });
});

it("names the main content only when it is what is missing", async () => {
  document.querySelector("#content")!.remove();
  const { ctx } = context();
  await act(() => mountTodoist(ctx));
  for (const timer of state.timers.splice(0)) timer();
  expect(state.reports.at(-1)).toEqual({
    language: "en",
    off: { views: "content" },
  });
});

it("tries the other view after a render failure and clears the page check once it renders", async () => {
  history.replaceState(null, "", "/app/today?todoist-plus=plan");
  state.crash = ["plan"];
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { ctx } = context();
  await act(() => mountTodoist(ctx));
  await screen.findByRole("button", { name: "Back to Todoist" });
  expect(state.reports.at(-1)!.off.views).toBe("renderError");
  // The sidebar coming back does not clear it while the crash line shows.
  document.querySelector("aside")!.outerHTML = sidebar;
  await settle();
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(state.reports.at(-1)!.off.views).toBe("renderError");

  fireEvent.click(screen.getByRole("button", { name: "Focus" }));
  expect(await screen.findByText("focus")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(state.reports.at(-1)!.off.views).toBeUndefined();

  // Plan fails again, then renders after Back and a fixed reopen.
  fireEvent.click(screen.getByRole("button", { name: "Plan" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Back to Todoist" }),
  );
  await settle();
  expect(state.reports.at(-1)!.off.views).toBe("renderError");
  state.crash = [];
  fireEvent.click(screen.getByRole("button", { name: "Plan" }));
  expect(await screen.findByText("plan")).toBeTruthy();
  expect(state.reports.at(-1)!.off.views).toBeUndefined();
});

it("brings a capped view back on the next click once the cap allows it", async () => {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { ctx } = context();
  await act(() => mountTodoist(ctx));
  await settle();
  for (let index = 0; index < 12; index++) {
    replaceContent();
    await settle();
  }
  expect(document.querySelector("todoist-plus-view")).toBeNull();
  expect(state.reports.at(-1)!.off.views).toBe("remountLimited");
  now += 61_000;
  // Nothing else on the page changes: the click alone mounts the view.
  fireEvent.click(screen.getByRole("button", { name: "Plan" }));
  expect(await screen.findByText("plan")).toBeTruthy();
  expect(visible("#native-2")).toBe(false);
});

it("keeps unrelated favourites visible when the plan read fails while their toggle loads", async () => {
  let release!: () => void;
  state.holdOtherViews = new Promise<void>((resolve) => (release = resolve));
  let fail!: (error: Error) => void;
  state.readPlan = new Promise<never>((_, reject) => (fail = reject));
  const { ctx } = context();
  await act(() => mountTodoist(ctx));
  await settle();
  expect(visible("#replaced")).toBe(false);
  expect(visible("#extra")).toBe(true);
  // Offline or a revoked token: Plus is off and everything shows again.
  fail(new Error("Synthetic network failure"));
  await settle();
  expect(visible("#replaced")).toBe(true);
  release();
  await settle();
  document.body.classList.add("later-change");
  await settle();
  expect(visible("#extra")).toBe(true);
  expect(
    document.querySelector<HTMLElement>("todoist-plus-other-views")!.style
      .display,
  ).toBe("none");
});
