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
import { AWAY_AFTER_MS, BEAT_MS } from "../src/idle-pause";
import type {
  FocusState,
  PlusActions,
  PlusData,
  TimerSnapshot,
} from "../src/model";

// Idle Detection, the permission, Web Locks and Document Picture-in-Picture are stubbed: jsdom has none of them.
// The fake detector reports what the test says the OS reports; the fake Tasks keeps the one timer.
type Timer = NonNullable<FocusState["timer"]>;
const NOW = Date.parse("2026-10-20T09:00:00Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

class FakeDetector extends EventTarget {
  static all: FakeDetector[] = [];
  static requestPermission = vi.fn(
    async (): Promise<PermissionState> => "granted",
  );
  userState: "active" | "idle" | null = null;
  screenState: "locked" | "unlocked" | null = null;
  options?: { threshold: number; signal: AbortSignal };
  constructor() {
    super();
    FakeDetector.all.push(this);
  }
  async start(options: { threshold: number; signal: AbortSignal }) {
    this.options = options;
    [this.userState, this.screenState] = os;
  }
}
let os: ["active" | "idle", "locked" | "unlocked"] = ["active", "unlocked"];
/** The detectors still running. */
const live = () =>
  FakeDetector.all.filter((detector) => !detector.options?.signal.aborted);
/** The OS reports a change to every running detector. */
async function report(user: "active" | "idle", screen: "locked" | "unlocked") {
  os = [user, screen];
  await act(async () => {
    for (const detector of live()) {
      detector.userState = user;
      detector.screenState = screen;
      detector.dispatchEvent(new Event("change"));
    }
  });
}
function stubIdleDetection(permission: PermissionState = "granted") {
  Object.defineProperty(window, "IdleDetector", {
    value: FakeDetector,
    configurable: true,
  });
  const status = Object.assign(new EventTarget(), { state: permission });
  Object.defineProperty(navigator, "permissions", {
    value: { query: vi.fn(async () => status) },
    configurable: true,
  });
  return status;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as { IdleDetector?: unknown }).IdleDetector;
  delete (window as { documentPictureInPicture?: unknown })
    .documentPictureInPicture;
  delete (navigator as { permissions?: unknown }).permissions;
  delete (navigator as { locks?: unknown }).locks;
  FakeDetector.all = [];
  FakeDetector.requestPermission.mockReset();
  os = ["active", "unlocked"];
  document.querySelectorAll("iframe").forEach((frame) => frame.remove());
});

const running = (value: Partial<Timer> = {}): Timer => ({
  taskId: "step",
  day: "2026-10-20",
  area: "work",
  status: "running",
  elapsedSeconds: 0,
  startedAt: iso(NOW - 20 * MIN),
  etag: "e1",
  ...value,
});
function data(timer: Timer | undefined = running()): PlusData {
  const task = {
    parentId: "",
    projectId: "inbox",
    planningFlags: [],
    area: "work" as const,
    stage: "none" as const,
    priority: 1,
    deadline: "",
    due: "",
    leadDays: 0,
    etag: "1",
    mustStart: false,
    missingLead: false,
  };
  return {
    plan: {
      tasks: [
        { ...task, id: "step", title: "Synthetic step", kind: "step" },
      ],
      week: "2026-10-19",
      today: "2026-10-20",
      timezone: "UTC",
      nextWeekTaskIds: [],
      dependencies: [],
      weeklyBets: [],
      laneOrders: {},
    },
    focus: {
      date: "2026-10-20",
      taskIds: ["step"],
      completedTaskIds: [],
      entries: [],
      timerEtag: timer?.etag ?? "e0",
      estimates: {},
      tasks: {},
      timer,
    },
    days: [],
  };
}
/** Tasks' one timer: each command moves it on, at `at` when given. */
function fakeTimer(start: Timer = running()) {
  let timer = start;
  let etag = 1;
  return vi.fn(
    async (
      action: string,
      _taskId: string,
      _focus: FocusState,
      _target?: number,
      _area?: string,
      at?: string,
    ): Promise<TimerSnapshot> => {
      const next = `e${++etag}`;
      const time = at ?? iso(Date.now());
      if (action === "pause")
        timer = { ...timer, status: "paused", pausedAt: time, etag: next };
      else if (action === "resume")
        timer = {
          ...running({ startedAt: time, etag: next }),
          elapsedSeconds: timer.elapsedSeconds,
        };
      else return { timerEtag: next };
      return { timerEtag: next, timer };
    },
  );
}
function mount(
  loaded: PlusData,
  props: Partial<PlanningAppProps> = {},
  more: Partial<PlusActions> = {},
) {
  const actions = {
    load: vi.fn().mockResolvedValue(loaded),
    timer: fakeTimer(loaded.focus.timer),
    completeTask: vi.fn().mockResolvedValue(undefined),
    ...more,
  } as unknown as PlusActions;
  const base: PlanningAppProps = {
    actions,
    view: "focus",
    language: "en",
    onOpenTask: vi.fn(),
    onSettings: vi.fn(),
    idlePause: true,
    onIdlePause: vi.fn(),
    ...props,
  };
  const view = render(<App {...base} />);
  return {
    actions,
    timer: actions.timer as ReturnType<typeof fakeTimer>,
    rerender: (next: Partial<PlanningAppProps>) =>
      view.rerender(<App {...base} {...next} />),
    unmount: view.unmount,
  };
}
const toggle = () =>
  screen.getByRole("checkbox", { name: "Pause when away" }) as HTMLInputElement;
const bar = () => screen.getByRole("complementary", { name: "Focus" });
/** What the main window's live regions say. */
const spoken = () =>
  screen.getAllByRole("status").map((region) => region.textContent);
/** Waits for the load and the detector's first reading. */
async function settled() {
  await screen.findByRole("button", { name: "Stop session" });
  await act(async () => {});
}

it("offers no toggle without the Idle Detection API, or without a host setting", async () => {
  mount(data());
  await settled();
  expect(screen.queryByRole("checkbox", { name: "Pause when away" })).toBeNull();
  cleanup();
  stubIdleDetection();
  mount(data(), { idlePause: undefined, onIdlePause: undefined });
  await settled();
  expect(screen.queryByRole("checkbox", { name: "Pause when away" })).toBeNull();
  expect(FakeDetector.all).toHaveLength(0);
});

it("asks for the permission only from the toggle's click; refused, it stays off with a note", async () => {
  stubIdleDetection("prompt");
  FakeDetector.requestPermission.mockResolvedValue("denied");
  const onIdlePause = vi.fn();
  const page = mount(data(), { idlePause: false, onIdlePause });
  await settled();
  expect(toggle().checked).toBe(false);
  expect(toggle().closest("label")?.title).toBe(
    "Count-up pauses when the screen locks or after 10 min without input, and asks when you’re back whether to count that time.",
  );
  expect(FakeDetector.requestPermission).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(toggle()));
  expect(FakeDetector.requestPermission).toHaveBeenCalledTimes(1);
  expect(onIdlePause).toHaveBeenLastCalledWith(false);
  expect(toggle().checked).toBe(false);
  expect(
    screen.getByText("The browser didn’t allow away detection."),
  ).toBeTruthy();
  expect(FakeDetector.all).toHaveLength(0);
  // Allowed on the next click: the host keeps the setting, and watching starts.
  FakeDetector.requestPermission.mockResolvedValue("granted");
  await act(async () => fireEvent.click(toggle()));
  expect(onIdlePause).toHaveBeenLastCalledWith(true);
  expect(
    screen.queryByText("The browser didn’t allow away detection."),
  ).toBeNull();
  page.rerender({ idlePause: true, onIdlePause });
  await act(async () => {});
  expect(toggle().checked).toBe(true);
  expect(live()).toHaveLength(1);
  // Turning it off asks nothing.
  await act(async () => fireEvent.click(toggle()));
  expect(onIdlePause).toHaveBeenLastCalledWith(false);
  expect(FakeDetector.requestPermission).toHaveBeenCalledTimes(2);
});

it("a revoked permission shows the toggle off", async () => {
  const status = stubIdleDetection("granted");
  mount(data());
  await settled();
  expect(toggle().checked).toBe(true);
  expect(live()).toHaveLength(1);
  await act(async () => {
    status.state = "denied";
    status.dispatchEvent(new Event("change"));
  });
  expect(toggle().checked).toBe(false);
  expect(live()).toHaveLength(0);
});

it("runs one detector at the 10-minute threshold while a count-up runs, and stops it with the setting, the session or the page", async () => {
  stubIdleDetection();
  const page = mount(data());
  await settled();
  expect(live()).toHaveLength(1);
  expect(live()[0]!.options).toEqual({
    threshold: AWAY_AFTER_MS,
    signal: expect.any(AbortSignal),
  });
  page.rerender({ idlePause: false });
  await act(async () => {});
  expect(live()).toHaveLength(0);
  page.rerender({ idlePause: true });
  await act(async () => {});
  expect(live()).toHaveLength(1);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Stop session" })),
  );
  expect(live()).toHaveLength(0);
  expect(FakeDetector.all).toHaveLength(2);
  cleanup();

  mount(data());
  await settled();
  expect(live()).toHaveLength(1);
  cleanup();
  expect(live()).toHaveLength(0);

  // A pomodoro is never watched.
  mount(data(running({ mode: "pomodoro", targetSeconds: 1500 })));
  await settled();
  expect(live()).toHaveLength(0);
});

it("pauses at the moment the screen locked; back, the bar and the mini timer ask, and Keep resumes at the pause", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  stubIdleDetection();
  const pip = stubPictureInPicture();
  const page = mount(data());
  await settled();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Mini timer" })),
  );
  const mini = within(pip.document.body);

  vi.setSystemTime(NOW + 5 * MIN);
  await report("active", "locked");
  expect(page.timer).toHaveBeenCalledTimes(1);
  expect(page.timer).toHaveBeenLastCalledWith(
    "pause",
    "step",
    expect.objectContaining({ timerEtag: "e1" }),
    undefined,
    undefined,
    iso(NOW + 5 * MIN),
  );
  expect(within(bar()).getByText("Paused")).toBeTruthy();

  vi.setSystemTime(NOW + 17 * MIN);
  await report("active", "unlocked");
  // The question takes Pause/Resume's place; Stop and Complete stay.
  expect(
    within(bar()).getByText("Away for 12 min — count it?").className,
  ).toBe("plus-away-question");
  expect(within(bar()).queryByRole("button", { name: "Resume" })).toBeNull();
  expect(
    within(bar()).getByRole("button", { name: "Stop session" }),
  ).toBeTruthy();
  expect(
    within(bar()).getByRole("button", { name: "Complete task" }),
  ).toBeTruthy();
  expect(spoken()).toContain("Away for 12 min — count it?");
  // The mini timer: the question in the step's line, the answers in the controls' place.
  const box = pip.document.querySelector<HTMLElement>(".mini")!;
  expect(box.hasAttribute("data-away")).toBe(true);
  expect(box.dataset.status).toBe("paused");
  expect(mini.getByRole("status").textContent).toBe(
    "Away for 12 min — count it?",
  );
  expect(mini.getByText("Away for 12 min — count it?").className).toBe(
    "mini-message mini-question",
  );
  expect(
    [...pip.document.querySelectorAll(".mini-answers button")].map(
      (button) => button.textContent,
    ),
  ).toEqual(["Keep", "Discard"]);
  expect(pip.document.querySelector(".mini-controls")).toBeNull();
  expect(pip.document.querySelector(".mini-foot")).toBeTruthy();

  await act(async () =>
    fireEvent.click(mini.getByRole("button", { name: "Keep" })),
  );
  expect(page.timer).toHaveBeenCalledTimes(2);
  expect(page.timer).toHaveBeenLastCalledWith(
    "resume",
    "step",
    expect.objectContaining({ timerEtag: "e2" }),
    undefined,
    undefined,
    iso(NOW + 5 * MIN),
  );
  expect(within(bar()).getByText("Focus")).toBeTruthy();
  expect(pip.document.querySelector(".mini")?.hasAttribute("data-away")).toBe(
    false,
  );
  expect(spoken()).toContain("Away time counted.");
  // Watching again: the next absence pauses again.
  vi.setSystemTime(NOW + 20 * MIN);
  await report("idle", "unlocked");
  expect(page.timer).toHaveBeenLastCalledWith(
    "pause",
    "step",
    expect.anything(),
    undefined,
    undefined,
    iso(NOW + 10 * MIN),
  );
});

it("a failed pause shows its error once and tries again quietly on the next beat; Discard resumes from now", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  stubIdleDetection();
  const tasks = fakeTimer();
  const timer = vi
    .fn(tasks)
    .mockRejectedValueOnce(new Error("Synthetic offline"))
    .mockRejectedValueOnce(new Error("Synthetic offline again"));
  const page = mount(data(), {}, { timer: timer as never });
  await settled();
  vi.setSystemTime(NOW + 5 * MIN);
  await report("active", "locked");
  expect(timer).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert").textContent).toContain("Synthetic offline");
  // The next beat sends the same pause; its failure shows nothing new.
  vi.setSystemTime(NOW + 5 * MIN + BEAT_MS);
  await act(async () => vi.advanceTimersByTime(BEAT_MS));
  expect(timer).toHaveBeenCalledTimes(2);
  expect(timer.mock.calls[1]!.slice(-1)).toEqual([iso(NOW + 5 * MIN)]);
  expect(screen.getByRole("alert").textContent).toContain("Synthetic offline");
  expect(screen.getByRole("alert").textContent).not.toContain("again");
  vi.setSystemTime(NOW + 5 * MIN + 2 * BEAT_MS);
  await act(async () => vi.advanceTimersByTime(BEAT_MS));
  expect(timer).toHaveBeenCalledTimes(3);
  expect(timer.mock.calls[2]!.slice(-1)).toEqual([iso(NOW + 5 * MIN)]);
  // Saved: the error goes.
  expect(screen.queryByRole("alert")).toBeNull();

  vi.setSystemTime(NOW + 30 * MIN);
  await report("active", "unlocked");
  await act(async () =>
    fireEvent.click(within(bar()).getByRole("button", { name: "Discard" })),
  );
  expect(timer).toHaveBeenLastCalledWith(
    "resume",
    "step",
    expect.anything(),
    undefined,
    undefined,
    undefined,
  );
  expect(spoken()).toContain("Resumed from now.");
  expect(within(bar()).getByRole("button", { name: "Pause" })).toBeTruthy();
  page.unmount();
});

it("watches in one window only: with the watch held elsewhere, it waits for it", async () => {
  stubIdleDetection();
  let grant: () => void = () => {};
  const request = vi.fn(
    (
      _name: string,
      options: { signal: AbortSignal },
      callback: () => Promise<void>,
    ) =>
      new Promise<void>((resolve, reject) => {
        grant = () => void callback().then(resolve);
        options.signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  Object.defineProperty(navigator, "locks", {
    value: { request },
    configurable: true,
  });
  mount(data());
  await settled();
  expect(request).toHaveBeenCalledWith(
    "tasks.idle-pause",
    { signal: expect.any(AbortSignal) },
    expect.any(Function),
  );
  expect(FakeDetector.all).toHaveLength(0);
  // The other window closed: this one takes the watch.
  await act(async () => grant());
  expect(live()).toHaveLength(1);
  cleanup();
  expect(live()).toHaveLength(0);
  expect(request.mock.calls[0]![1].signal.aborted).toBe(true);
});

it("behind another page, the timer bar shows only while the question waits", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  stubIdleDetection();
  const page = mount(data());
  await settled();
  page.rerender({ background: true });
  expect(screen.queryByRole("complementary")).toBeNull();
  vi.setSystemTime(NOW + 5 * MIN);
  await report("active", "locked");
  expect(page.timer).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("complementary")).toBeNull();
  vi.setSystemTime(NOW + 9 * MIN);
  await report("active", "unlocked");
  expect(within(bar()).getByText("Away for 4 min — count it?")).toBeTruthy();
  expect(screen.queryByRole("heading")).toBeNull();
  expect(document.querySelector(".plus-root")?.className).toBe(
    "plus-root plus-root-background",
  );
  await act(async () =>
    fireEvent.click(within(bar()).getByRole("button", { name: "Keep" })),
  );
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(document.querySelector(".plus-root")).toBeNull();
});

it("turned off while away, it asks at once", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  stubIdleDetection();
  const page = mount(data());
  await settled();
  vi.setSystemTime(NOW + 5 * MIN);
  await report("idle", "unlocked");
  // Idle at 09:05 is no input since 08:55, before the session's segment: Tasks moves it to its start.
  expect(page.timer.mock.calls[0]!.at(-1)).toBe(iso(NOW - 5 * MIN));
  vi.setSystemTime(NOW + 7 * MIN);
  page.rerender({ idlePause: false });
  await act(async () => {});
  expect(live()).toHaveLength(0);
  expect(within(bar()).getByText("Away for 12 min — count it?")).toBeTruthy();
});

/** Document Picture-in-Picture with a window whose document is an iframe's, as in mini-timer.test.tsx. */
function stubPictureInPicture() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const events = new EventTarget();
  const pip = {
    document: frame.contentDocument!,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    setTimeout: () => 0,
    clearTimeout: () => {},
    close: () => events.dispatchEvent(new Event("pagehide")),
  };
  Object.defineProperty(window, "documentPictureInPicture", {
    value: { requestWindow: async () => pip },
    configurable: true,
  });
  return pip;
}
