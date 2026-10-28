import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App, type PlanningAppProps } from "../src/App";
import { miniRule } from "../src/MiniTimer";
import type {
  FocusState,
  PlusActions,
  PlusData,
  TimerSnapshot,
} from "../src/model";

// Document Picture-in-Picture is stubbed: jsdom has none. Each window is a fake whose document is another
// realm's (an iframe's, as a PiP window's is), whose timers are its own, and whose first close() fires
// pagehide as Chrome's does.
type Timer = NonNullable<FocusState["timer"]>;
const NOW = Date.parse("2026-10-17T12:00:00Z");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as { documentPictureInPicture?: unknown })
    .documentPictureInPicture;
  document.querySelectorAll("iframe").forEach((frame) => frame.remove());
});

function fakeWindow() {
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
type Fake = ReturnType<typeof fakeWindow>;
/** Chrome's API: each request opens a new window. */
function stubPictureInPicture() {
  const windows: Fake[] = [];
  const requestWindow = vi.fn(async () => {
    windows.push(fakeWindow());
    return windows.at(-1)!;
  });
  Object.defineProperty(window, "documentPictureInPicture", {
    value: { requestWindow },
    configurable: true,
  });
  return { windows, requestWindow };
}

const timer = (value: Partial<Timer> = {}): Timer => ({
  taskId: "step",
  day: "2026-10-17",
  area: "work",
  status: "running",
  elapsedSeconds: 0,
  startedAt: new Date(NOW - (24 * 60 + 13) * 1000).toISOString(),
  etag: "running",
  ...value,
});
function data(session: Timer | undefined = timer()): PlusData {
  return {
    plan: {
      tasks: [
        {
          id: "outcome",
          title: "Synthetic outcome",
          parentId: "",
          projectId: "inbox",
          planningFlags: [],
          area: "work",
          stage: "committed",
          priority: 1,
          deadline: "",
          due: "",
          leadDays: 0,
          etag: "1",
          mustStart: false,
          missingLead: false,
        },
        {
          id: "step",
          title: "Synthetic focused step",
          parentId: "outcome",
          projectId: "inbox",
          kind: "step",
          planningFlags: [],
          area: "work",
          stage: "none",
          priority: 1,
          deadline: "",
          due: "",
          leadDays: 0,
          estimatedMinutes: 45,
          etag: "1",
          mustStart: false,
          missingLead: false,
        },
      ],
      week: "2026-10-12",
      today: "2026-10-17",
      timezone: "UTC",
      nextWeekTaskIds: [],
      dependencies: [],
      weeklyBets: [],
      laneOrders: {},
    },
    focus: {
      date: "2026-10-17",
      taskIds: ["step"],
      completedTaskIds: [],
      entries: [],
      timerEtag: session?.etag ?? "idle",
      estimates: {},
      tasks: {},
      timer: session,
    },
    days: [],
  };
}
function mount(loaded: PlusData, more: Partial<PlusActions> = {}) {
  const actions = {
    load: vi.fn().mockResolvedValue(loaded),
    timer: vi.fn(
      async (): Promise<TimerSnapshot> => ({
        timerEtag: "paused",
        timer: timer({ status: "paused", etag: "paused", elapsedSeconds: 60 }),
      }),
    ),
    completeTask: vi.fn().mockResolvedValue(undefined),
    ...more,
  } as unknown as PlusActions;
  const props: PlanningAppProps = {
    actions,
    view: "focus",
    language: "en",
    onOpenTask: vi.fn(),
    onSettings: vi.fn(),
  };
  const view = render(<App {...props} />);
  return {
    actions,
    rerender: (next: Partial<PlanningAppProps>) =>
      view.rerender(<App {...props} {...next} />),
    unmount: view.unmount,
  };
}
const toggle = () => screen.getByRole("button", { name: "Mini timer" });
/** Presses the timer bar's toggle; answers the window it opened and queries in it. */
async function open(stub: ReturnType<typeof stubPictureInPicture>) {
  await act(async () => fireEvent.click(toggle()));
  const pip = stub.windows.at(-1)!;
  return { pip, mini: within(pip.document.body) };
}

it("offers no mini timer without Document Picture-in-Picture", async () => {
  mount(data());
  await screen.findByRole("button", { name: "Stop session" });
  expect(screen.queryByRole("button", { name: "Mini timer" })).toBeNull();
});

it("opens a 320 × 120 window with its stylesheet, the page's tokens and font, and the step", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const stub = stubPictureInPicture();
  mount(data());
  await screen.findByRole("button", { name: "Mini timer" });
  const root = document.querySelector<HTMLElement>(".plus-root")!;
  // The host's override, as Tasks sets --plus-accent on .planning-ui.
  root.style.setProperty("--plus-accent", "#50743b");
  root.style.fontFamily = "SyntheticSans, sans-serif";
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  const { pip, mini } = await open(stub);
  expect(stub.requestWindow).toHaveBeenCalledWith({ width: 320, height: 120 });
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  const html = pip.document.documentElement;
  expect(pip.document.head.querySelectorAll("style")).toHaveLength(1);
  expect(pip.document.head.textContent).toContain(".mini-time");
  expect(html.style.getPropertyValue("--plus-accent")).toBe("#50743b");
  expect(html.style.fontFamily).toBe("SyntheticSans, sans-serif");
  expect(html.lang).toBe("en");
  expect(pip.document.title).toBe("Focus");
  // The step, its outcome, the time and the rule: 24:13 of a 45 minute estimate.
  const box = pip.document.querySelector<HTMLElement>(".mini")!;
  expect(box.dataset.status).toBe("running");
  expect(box.dataset.progress).toBe("on");
  expect(box.getAttribute("aria-busy")).toBe("false");
  expect(box.style.getPropertyValue("--area-color")).toBe(
    "var(--plus-area-work)",
  );
  expect(Number(box.style.getPropertyValue("--progress"))).toBeCloseTo(
    1453 / 2700,
  );
  expect(mini.getByText("Synthetic outcome").className).toBe("mini-outcome");
  expect(mini.getByText("Synthetic focused step").className).toBe("mini-title");
  const time = mini.getByRole("timer");
  expect(time.textContent).toBe("24:13");
  expect(time.getAttribute("aria-label")).toBe("Session");
  expect(pip.document.querySelector(".mini-label")?.textContent).toBe(
    "24m / 45m",
  );
  const progress = mini.getByRole("progressbar", {
    name: "Logged time / estimate",
  });
  expect(progress.getAttribute("aria-valuetext")).toBe("24m / 45m");
  expect(Number(progress.getAttribute("aria-valuenow"))).toBeCloseTo(1453 / 60);
});

it("acts through the timer bar's own commands and the one write queue", async () => {
  const stub = stubPictureInPicture();
  const { actions } = mount(data());
  await screen.findByRole("button", { name: "Mini timer" });
  const { pip, mini } = await open(stub);
  await act(async () =>
    fireEvent.click(
      mini.getByRole("button", { name: "Pause: Synthetic focused step" }),
    ),
  );
  expect(actions.timer).toHaveBeenCalledTimes(1);
  expect(actions.timer).toHaveBeenLastCalledWith(
    "pause",
    "step",
    expect.objectContaining({ timerEtag: "running" }),
    undefined,
    undefined,
  );
  // Paused, in the main window too: the status shows at rest, and the first control resumes.
  expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  expect(pip.document.querySelector(".mini")?.getAttribute("data-status")).toBe(
    "paused",
  );
  expect(pip.document.querySelector(".mini-status")?.textContent).toBe(
    "Paused",
  );
  await act(async () =>
    fireEvent.click(
      mini.getByRole("button", { name: "Resume: Synthetic focused step" }),
    ),
  );
  expect(actions.timer).toHaveBeenLastCalledWith(
    "resume",
    "step",
    expect.objectContaining({ timerEtag: "paused" }),
    undefined,
    undefined,
  );
  await act(async () =>
    fireEvent.click(
      mini.getByRole("button", {
        name: "Stop session: Synthetic focused step",
      }),
    ),
  );
  expect(actions.timer).toHaveBeenLastCalledWith(
    "stop",
    "step",
    expect.anything(),
    undefined,
    undefined,
  );
  expect(actions.timer).toHaveBeenCalledTimes(3);
});

it("completes the step through the same completion and closes once it is confirmed", async () => {
  const stub = stubPictureInPicture();
  const { actions } = mount(data());
  await screen.findByRole("button", { name: "Mini timer" });
  const { pip, mini } = await open(stub);
  await act(async () =>
    fireEvent.click(
      mini.getByRole("button", {
        name: "Complete task: Synthetic focused step",
      }),
    ),
  );
  expect(actions.completeTask).toHaveBeenCalledTimes(1);
  expect(actions.completeTask).toHaveBeenCalledWith(
    expect.objectContaining({ id: "step" }),
    expect.any(String),
    "2026-10-17",
  );
  expect(pip.closed).toBe(true);
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
});

it("leaves out Complete for a step Plan does not list, and shows Focus when no step is known", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const loaded = data(timer({ taskId: "elsewhere" }));
  loaded.focus.tasks.elsewhere = {
    title: "Synthetic unlisted step",
    parentId: "",
    parentTitle: "",
    estimatedMinutes: 60,
    completed: false,
  };
  const stub = stubPictureInPicture();
  mount(loaded);
  await screen.findByRole("button", { name: "Mini timer" });
  const { pip, mini } = await open(stub);
  expect(mini.getByText("Synthetic unlisted step")).toBeTruthy();
  expect(
    mini.getByRole("button", { name: "Stop session: Synthetic unlisted step" }),
  ).toBeTruthy();
  expect(mini.queryByRole("button", { name: /^Complete task/u })).toBeNull();
  // Its estimate comes from Tasks' Focus read.
  expect(pip.document.querySelector(".mini-label")?.textContent).toBe(
    "24m / 1h",
  );
  cleanup();

  const unknown = stubPictureInPicture();
  mount(data(timer({ taskId: "gone" })));
  await screen.findByRole("button", { name: "Mini timer" });
  const nothing = (await open(unknown)).mini;
  const title = nothing.getByText("Focus");
  expect(title.className).toBe("mini-title is-fallback");
  expect(title.hasAttribute("title")).toBe(false);
  expect(nothing.getByRole("button", { name: "Pause: Focus" })).toBeTruthy();
  expect(nothing.queryByRole("button", { name: /^Complete task/u })).toBeNull();
});

it("disables every control while a write waits, then shows a failed write until the next one", async () => {
  const stub = stubPictureInPicture();
  let fail: (reason: Error) => void = () => {};
  const { actions } = mount(data(), {
    timer: vi.fn(
      () =>
        new Promise<TimerSnapshot>((_, reject) => {
          fail = reject;
        }),
    ),
  });
  await screen.findByRole("button", { name: "Mini timer" });
  const { pip, mini } = await open(stub);
  await act(async () =>
    fireEvent.click(
      mini.getByRole("button", { name: "Pause: Synthetic focused step" }),
    ),
  );
  const buttons = mini.getAllByRole("button") as HTMLButtonElement[];
  expect(buttons).toHaveLength(3);
  expect(buttons.every((button) => button.disabled)).toBe(true);
  expect(pip.document.querySelector(".mini")?.getAttribute("aria-busy")).toBe(
    "true",
  );
  await act(async () => fail(new Error("Synthetic conflict")));
  // The main window keeps the full error; the mini timer says only that it was not saved.
  expect(screen.getByRole("alert").textContent).toContain("Synthetic conflict");
  expect(mini.getByText("Not saved. Check the main window.").className).toBe(
    "mini-message mini-error",
  );
  expect(pip.document.querySelector(".mini-foot")).toBeNull();
  (actions.timer as ReturnType<typeof vi.fn>).mockResolvedValue({
    timerEtag: "paused",
    timer: timer({ status: "paused", etag: "paused" }),
  });
  await act(async () =>
    fireEvent.click(
      mini.getByRole("button", { name: "Pause: Synthetic focused step" }),
    ),
  );
  expect(mini.queryByText("Not saved. Check the main window.")).toBeNull();
  expect(pip.document.querySelector(".mini-foot")).toBeTruthy();
});

it("closes when the session ends and when the page unmounts; the owner closing it unpresses the button", async () => {
  const stub = stubPictureInPicture();
  const page = mount(data(), {
    timer: vi.fn(async () => ({ timerEtag: "idle" })),
  });
  await screen.findByRole("button", { name: "Mini timer" });
  const first = await open(stub);
  await act(async () =>
    fireEvent.click(
      first.mini.getByRole("button", {
        name: "Stop session: Synthetic focused step",
      }),
    ),
  );
  expect(page.actions.timer).toHaveBeenCalledWith(
    "stop",
    "step",
    expect.anything(),
    undefined,
    undefined,
  );
  expect(first.pip.closed).toBe(true);
  expect(screen.queryByRole("button", { name: "Mini timer" })).toBeNull();
  cleanup();

  const again = stubPictureInPicture();
  const second = mount(data());
  await screen.findByRole("button", { name: "Mini timer" });
  // The owner closes it: Chrome fires pagehide.
  const closedByOwner = await open(again);
  await act(async () => closedByOwner.pip.close());
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  // Pressed again, it opens a new window; pressed once more, it closes it.
  const toggled = await open(again);
  expect(again.requestWindow).toHaveBeenCalledTimes(2);
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  await act(async () => fireEvent.click(toggle()));
  expect(toggled.pip.closed).toBe(true);
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  const unmounted = await open(again);
  second.unmount();
  expect(unmounted.pip.closed).toBe(true);
});

it("closes a window that opens after the session ended or the page left", async () => {
  // Chrome answers the request later than the click.
  const opened: ((pip: Fake) => void)[] = [];
  Object.defineProperty(window, "documentPictureInPicture", {
    value: {
      requestWindow: vi.fn(
        () => new Promise<Fake>((resolve) => opened.push(resolve)),
      ),
    },
    configurable: true,
  });
  const page = mount(data(), {
    timer: vi.fn(async () => ({ timerEtag: "idle" })),
  });
  await screen.findByRole("button", { name: "Mini timer" });
  fireEvent.click(toggle());
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Stop session" })),
  );
  const late = fakeWindow();
  await act(async () => opened[0]!(late));
  expect(late.closed).toBe(true);
  cleanup();

  mount(data());
  await screen.findByRole("button", { name: "Mini timer" });
  fireEvent.click(toggle());
  cleanup();
  const orphan = fakeWindow();
  await act(async () => opened[1]!(orphan));
  expect(orphan.closed).toBe(true);
  expect(page.actions.timer).toHaveBeenCalledTimes(1);
});

it("ticks on the mini timer's own timers, at the session's next whole second", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const stub = stubPictureInPicture();
  mount(data());
  await act(async () => {});
  const { pip, mini } = await open(stub);
  const time = mini.getByRole("timer");
  expect(time.textContent).toBe("24:13");
  expect(pip.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 1000);
  // The main window's timers (run late while it is hidden) do not tick it: the bar moves on, it does not.
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByRole("complementary").textContent).toContain("24:14");
  expect(time.textContent).toBe("24:13");
  act(() => pip.tick());
  expect(time.textContent).toBe("24:14");
  vi.setSystemTime(NOW + 1400);
  act(() => pip.tick());
  expect(pip.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 600);
});

it("keeps the mini timer and nothing else in the background, and reports the session", async () => {
  const stub = stubPictureInPicture();
  const onSession = vi.fn();
  const page = mount(data());
  page.rerender({ onSession });
  await screen.findByRole("button", { name: "Mini timer" });
  expect(onSession).toHaveBeenLastCalledWith(true);
  const { pip, mini } = await open(stub);
  page.rerender({ onSession, background: true });
  expect(document.querySelector(".plus-root")).toBeNull();
  expect(screen.queryByRole("complementary")).toBeNull();
  // The same window and nodes, still working.
  expect(pip.closed).toBe(false);
  expect(pip.document.querySelectorAll(".mini")).toHaveLength(1);
  await act(async () =>
    fireEvent.click(
      mini.getByRole("button", { name: "Pause: Synthetic focused step" }),
    ),
  );
  expect(page.actions.timer).toHaveBeenCalledTimes(1);
  expect(pip.document.querySelector(".mini-status")?.textContent).toBe(
    "Paused",
  );
  // Stopped: the session ends, which the host hears, and the window closes.
  (page.actions.timer as ReturnType<typeof vi.fn>).mockResolvedValue({
    timerEtag: "idle",
  });
  await act(async () =>
    fireEvent.click(
      mini.getByRole("button", {
        name: "Stop session: Synthetic focused step",
      }),
    ),
  );
  expect(onSession).toHaveBeenLastCalledWith(false);
  expect(pip.closed).toBe(true);
});

it("waits with full reads in the background and reads once when shown again", async () => {
  const page = mount(data());
  await screen.findByRole("button", { name: "Stop session" });
  expect(page.actions.load).toHaveBeenCalledTimes(1);
  // A task write elsewhere while another page shows.
  page.rerender({ background: true, refreshRevision: 1 });
  await act(async () => {});
  expect(page.actions.load).toHaveBeenCalledTimes(1);
  page.rerender({ background: false, refreshRevision: 1 });
  await act(async () => {});
  expect(page.actions.load).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("heading", { name: "Focus" })).toBeTruthy();
  // A recent read with nothing missed is not repeated.
  page.rerender({ background: true, refreshRevision: 1 });
  page.rerender({ background: false, refreshRevision: 1 });
  await act(async () => {});
  expect(page.actions.load).toHaveBeenCalledTimes(2);
});

it("behind another page, a task write elsewhere reads the timer at once, and in full while the mini timer is open", async () => {
  const stub = stubPictureInPicture();
  const onSession = vi.fn();
  const readTimer = vi.fn(
    async (): Promise<TimerSnapshot> => ({
      timerEtag: "running",
      timer: timer(),
    }),
  );
  const page = mount(data(), { readTimer });
  page.rerender({ onSession });
  await screen.findByRole("button", { name: "Mini timer" });
  const { pip } = await open(stub);
  // Open, its Complete needs the task's current etag: a full read now, which here shows the step completed on
  // Today. The session ended, so the window closes at once and the host hears it.
  const ended = data();
  ended.focus = { ...ended.focus, timer: undefined, timerEtag: "idle" };
  (page.actions.load as ReturnType<typeof vi.fn>).mockResolvedValue(ended);
  page.rerender({ onSession, background: true, refreshRevision: 1 });
  await act(async () => {});
  expect(page.actions.load).toHaveBeenCalledTimes(2);
  expect(readTimer).not.toHaveBeenCalled();
  expect(pip.closed).toBe(true);
  expect(onSession).toHaveBeenLastCalledWith(false);
  cleanup();

  // Closed: only the timer is read, and the full read waits for Plan or Focus.
  const again = mount(data(), { readTimer });
  again.rerender({ onSession });
  await screen.findByRole("button", { name: "Stop session" });
  again.rerender({ onSession, background: true, refreshRevision: 1 });
  await act(async () => {});
  expect(readTimer).toHaveBeenCalledTimes(1);
  expect(again.actions.load).toHaveBeenCalledTimes(1);
  expect(onSession).toHaveBeenLastCalledWith(true);
  readTimer.mockResolvedValue({ timerEtag: "idle" });
  again.rerender({ onSession, background: true, refreshRevision: 2 });
  await act(async () => {});
  expect(readTimer).toHaveBeenCalledTimes(2);
  expect(onSession).toHaveBeenLastCalledWith(false);
  again.rerender({ onSession, background: false, refreshRevision: 2 });
  await act(async () => {});
  expect(again.actions.load).toHaveBeenCalledTimes(2);
});

it("mounted behind another page with nothing read, it reads once to learn the session", async () => {
  const onSession = vi.fn();
  const actions = {
    load: vi.fn().mockResolvedValue(data()),
    timer: vi.fn(),
    readTimer: vi.fn(),
    completeTask: vi.fn(),
  } as unknown as PlusActions;
  render(
    <App
      actions={actions}
      view="focus"
      language="en"
      onOpenTask={vi.fn()}
      onSettings={vi.fn()}
      background
      onSession={onSession}
    />,
  );
  await act(async () => {});
  expect(actions.load).toHaveBeenCalledTimes(1);
  expect(actions.readTimer).not.toHaveBeenCalled();
  expect(onSession).toHaveBeenLastCalledWith(true);
  expect(document.querySelector(".plus-root")).toBeNull();
});

it("measures the rule as Focus's card does", () => {
  const running = timer();
  // Count-up: logged time against the estimate, in bands.
  expect(miniRule(running, 600, 600, 0, "en")).toEqual({
    band: "none",
    progress: 0,
    label: "",
  });
  // Below 90%, no label of its own: the logged time / estimate shows.
  expect(miniRule(running, 600, 1200, 45, "en")).toEqual({
    band: "on",
    progress: 1200 / 2700,
    label: "",
  });
  // From 90%, the minutes left, rounded up.
  expect(miniRule(running, 0, 2430, 45, "en")).toMatchObject({
    band: "near",
    progress: 0.9,
    label: "5m left",
  });
  expect(miniRule(running, 0, 2481, 45, "zh").label).toBe("剩 4m");
  // Past it, the minutes over, rounded up from the first second; progress is where the estimate falls.
  expect(miniRule(running, 0, 2701, 45, "en")).toMatchObject({
    band: "over",
    progress: 2700 / 2701,
    label: "1m over",
  });
  expect(miniRule(running, 0, 3090, 45, "zh").label).toBe("超 7m");
  // A pomodoro: its time against its length.
  expect(
    miniRule(
      timer({ mode: "pomodoro", targetSeconds: 1500 }),
      375,
      9999,
      45,
      "en",
    ),
  ).toEqual({ band: "on", progress: 0.25, label: "" });
});

it("counts a pomodoro down and fills an unassigned step's rule in the muted tone", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const stub = stubPictureInPicture();
  mount(
    data(
      timer({
        mode: "pomodoro",
        targetSeconds: 1500,
        area: "unassigned",
        startedAt: new Date(NOW - 378_000).toISOString(),
      }),
    ),
  );
  await screen.findByRole("button", { name: "Mini timer" });
  const { pip, mini } = await open(stub);
  expect(mini.getByRole("timer").textContent).toBe("18:42");
  const box = pip.document.querySelector<HTMLElement>(".mini")!;
  expect(box.style.getPropertyValue("--area-color")).toBe("");
  expect(Number(box.style.getPropertyValue("--progress"))).toBeCloseTo(
    378 / 1500,
  );
  expect(pip.document.querySelector(".mini-label")?.textContent).toBe(
    "6m / 25m",
  );
});

it("counts earlier records separately from an hour-long session", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const loaded = data(
    timer({ startedAt: new Date(NOW - 3899_000).toISOString() }),
  );
  loaded.focus.entries = [
    {
      id: "earlier",
      taskId: "step",
      date: "2026-10-17",
      seconds: 1200,
      source: "manual",
      area: "work",
      etag: "1",
    },
  ];
  const stub = stubPictureInPicture();
  mount(loaded);
  await screen.findByRole("button", { name: "Mini timer" });
  const { pip, mini } = await open(stub);
  const time = mini.getByRole("timer");
  expect(time.textContent).toBe("1:04:59");
  // 20m recorded and 1:04:59 now: 40 minutes over 45.
  expect(
    pip.document.querySelector(".mini")?.getAttribute("data-progress"),
  ).toBe("over");
  expect(pip.document.querySelector(".mini-label")?.textContent).toBe(
    "40m over",
  );
});

it("keeps an unestimated session honest instead of drawing an empty estimate track", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const loaded = data();
  loaded.plan.tasks[1]!.estimatedMinutes = 0;
  const stub = stubPictureInPicture();
  mount(loaded);
  await screen.findByRole("button", { name: "Mini timer" });
  const { mini } = await open(stub);
  expect(mini.getByRole("timer", { name: "Session" }).textContent).toBe(
    "24:13",
  );
  expect(mini.getByText("Not estimated")).toBeTruthy();
  expect(mini.queryByRole("progressbar")).toBeNull();
});
