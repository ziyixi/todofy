import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { mountTodoist } from "../src/mount";
import type { PlanConfig } from "../src/model";

// A synthetic Todoist shell; the real built extension runs in the packaged browser tests.
const state = vi.hoisted(() => ({
  config: undefined as PlanConfig | undefined,
  crash: false,
  rejectMounts: 0,
  mounted: [] as string[],
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
    readPlan: () => new Promise(() => {}),
  },
  openOptions: () => {},
}));
vi.mock("../src/App", () => ({
  App: ({ view }: { view: string }) => {
    if (state.crash) throw new Error("Synthetic render failure");
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
    crash: false,
    rejectMounts: 0,
    mounted: [],
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
  state.crash = true;
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

it("stops and restores Todoist when its own passes never end", async () => {
  history.replaceState(null, "", "/app/today?todoist-plus=plan");
  const { ctx } = context();
  await act(() => mountTodoist(ctx));
  await screen.findByText("plan");
  await act(async () => {
    for (let index = 0; index < 1600; index++) {
      document.body.classList.toggle("synthetic-loop");
      await new Promise((resolve) => queueMicrotask(() => resolve(null)));
      await new Promise((resolve) => queueMicrotask(() => resolve(null)));
    }
  });
  expect(document.querySelector("todoist-plus-view")).toBeNull();
  expect(visible("#native")).toBe(true);
  expect(visible("#replaced")).toBe(true);
});
