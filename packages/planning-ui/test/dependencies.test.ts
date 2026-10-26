import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addDays } from "../src/domain";
import { unplannedDue } from "../src/deadlines";
import {
  candidates,
  dependencyIndex,
  doneText,
  holds,
  waitersText,
  waitingForStatus,
  waitingTasks,
  waitsThrough,
} from "../src/dependencies";
import { applyConfirmed, rereadsAfter } from "../src/plan-updates";
import {
  boardLanes,
  cardState,
  cardStatus,
  statusLine,
} from "../src/review-lanes";
import { createPrototype } from "./fixture";
import type { PlanningTask, TaskDependency } from "../src/model";

// A synthetic Thursday; "now" is its noon.
const TODAY = "2026-10-15";
const on = (days: number) => addDays(TODAY, days);
beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse(`${TODAY}T12:00:00Z`), toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});
const task = (id: string, value: Partial<PlanningTask> = {}): PlanningTask => ({
  id,
  title: `Synthetic ${id}`,
  parentId: "",
  projectId: "synthetic",
  area: "work",
  stage: "none",
  priority: 1,
  deadline: "",
  due: "",
  leadDays: 0,
  etag: id,
  mustStart: false,
  missingLead: false,
  ...value,
});
const waitsFor = (
  taskId: string,
  prerequisiteId: string,
  value: Partial<TaskDependency> = {},
): TaskDependency => ({
  taskId,
  prerequisiteId,
  done: false,
  ...value,
});

it("holds while the prerequisite is listed and Tasks does not say it is done", () => {
  const edge = waitsFor("a", "b");
  expect(holds(edge, task("b"))).toBe(true);
  // Missing from a complete read: done, completed or deleted alike.
  expect(holds(edge, undefined)).toBe(false);
  // A recurring prerequisite stays listed; Tasks says when it was completed again.
  const recurring = task("b", { recurring: true, completedCount: 4 });
  expect(holds(edge, recurring)).toBe(true);
  expect(holds({ ...edge, done: true }, recurring)).toBe(false);
});

it("indexes what each active task waits for, what is done and who waits", () => {
  const tasks = [
    task("invite"),
    task("venue"),
    task("budget"),
    task("weekly", { recurring: true, completedCount: 2 }),
  ];
  const dependencies = [
    waitsFor("invite", "venue"),
    waitsFor("invite", "gone", { done: true }),
    waitsFor("invite", "weekly", { done: true }),
    waitsFor("budget", "venue"),
    // A waiter that is gone itself waits for nothing.
    waitsFor("closed", "venue"),
  ];
  const index = dependencyIndex({ tasks, dependencies });
  expect(index.waitingFor.get("invite")?.map((item) => item.id)).toEqual([
    "venue",
  ]);
  expect(
    index.done.get("invite")?.map((dependency) => dependency.prerequisiteId),
  ).toEqual(["gone", "weekly"]);
  expect(
    index.holding.map((dependency) => [
      dependency.taskId,
      dependency.prerequisiteId,
    ]),
  ).toEqual([
    ["invite", "venue"],
    ["budget", "venue"],
  ]);
  expect(index.waiters.get("venue")?.map((item) => item.id)).toEqual([
    "invite",
    "budget",
  ]);
  expect(index.waitingFor.has("closed") || index.waitingFor.has("weekly")).toBe(
    false,
  );
  // Built once per pair of lists.
  expect(dependencyIndex({ tasks, dependencies })).toBe(index);
});

it("lists label and dependency waits together, the longest untouched first", () => {
  const tasks = [
    task("label", {
      planningFlags: ["waiting"],
      updatedAt: "2026-10-10T00:00:00Z",
    }),
    task("dependent", { updatedAt: "2026-10-01T00:00:00Z" }),
    task("venue", { updatedAt: "2026-09-01T00:00:00Z" }),
    task("unknown", { planningFlags: ["blocked"] }),
  ];
  expect(
    waitingTasks({ tasks, dependencies: [waitsFor("dependent", "venue")] }).map(
      (item) => item.id,
    ),
  ).toEqual(["dependent", "label", "unknown"]);
});

it("detects a cycle through other tasks as Tasks does", () => {
  const dependencies = [
    waitsFor("a", "b"),
    waitsFor("b", "c"),
    waitsFor("x", "y"),
  ];
  expect(waitsThrough(dependencies, "a", "c")).toBe(true);
  expect(waitsThrough(dependencies, "c", "a")).toBe(false);
  expect(waitsThrough([waitsFor("a", "b"), waitsFor("b", "a")], "a", "z")).toBe(
    false,
  );
});

it("offers matching tasks by title or parent, never the task's own family or a linked one, and greys what it cannot take", () => {
  const tasks = [
    task("launch", { title: "Product launch" }),
    task("invite", { title: "Send invitations", parentId: "launch" }),
    task("rehearsal", { title: "Launch rehearsal", parentId: "launch" }),
    task("venue", { title: "Book the venue" }),
    task("menu", { title: "Choose the menu", parentId: "venue" }),
    task("deck", { title: "Launch deck" }),
    task("review", {
      title: "Weekly launch review",
      recurring: true,
      completedCount: 0,
    }),
    task("sync", { title: "Launch sync", recurring: true, completedCount: 5 }),
    task("blocked", { title: "Launch blog post" }),
  ];
  const dependencies = [
    waitsFor("invite", "deck"),
    waitsFor("blocked", "invite"),
  ];
  const plan = { tasks, dependencies };
  const invite = tasks[1]!;
  const shown = (query: string) =>
    candidates(plan, invite, query).map((item) => [
      item.task.id,
      item.refusal ?? item.path,
    ]);
  // Its parent and its steps are its family; the deck is already linked.
  expect(shown("launch")).toEqual([
    ["rehearsal", "Product launch"],
    ["review", ""],
    ["sync", ""],
    ["blocked", "cycle"],
  ]);
  // A parent's title finds its steps.
  expect(shown("VENUE")).toEqual([
    ["venue", ""],
    ["menu", "Book the venue"],
  ]);
  expect(shown("  ")).toEqual([]);
  expect(candidates(plan, tasks[0]!, "e", 2)).toHaveLength(2);
});

it("offers a recurring prerequisite again once completed, and greys a cycle only by dependencies that hold", () => {
  const tasks = [
    task("report", { title: "Weekly report" }),
    task("sync", { title: "Team sync", recurring: true, completedCount: 5 }),
    task("draft", { title: "Draft notes" }),
  ];
  const report = tasks[0]!;
  const shown = (dependencies: TaskDependency[], who = report, query = "") =>
    candidates({ tasks, dependencies }, who, query || "t").map((item) => [
      item.task.id,
      item.refusal ?? "",
    ]);
  // The sync was completed again since: done, so it can be chosen to wait for its next completion.
  expect(shown([waitsFor("report", "sync", { done: true })])).toEqual([
    ["sync", ""],
    ["draft", ""],
  ]);
  expect(shown([waitsFor("report", "sync")])).toEqual([["draft", ""]]);
  // The draft once waited for the report through the sync, which is done: no cycle any more.
  const through = [
    waitsFor("draft", "sync", { done: true }),
    waitsFor("sync", "report"),
  ];
  expect(shown(through, report, "dra")).toEqual([["draft", ""]]);
  expect(shown([waitsFor("draft", "report")], report, "dra")).toEqual([
    ["draft", "cycle"],
  ]);
});

it("writes the quiet texts in both languages", () => {
  const venue = task("venue", { title: "Book the venue" });
  const invite = task("invite", { title: "Send invitations" });
  const waiting = (prerequisites: PlanningTask[], language: "zh" | "en") =>
    statusLine([waitingForStatus(prerequisites, language)]);
  expect(waiting([venue], "zh")).toBe("等「Book the venue」");
  expect(waitingForStatus([venue], "zh").quoted?.title).toBe("Book the venue");
  expect(waiting([venue, invite], "zh")).toBe("等 2 项");
  expect(waiting([venue], "en")).toBe("Waiting for “Book the venue”");
  expect(waiting([venue, invite], "en")).toBe("Waiting for 2 tasks");
  expect(doneText(1, 1, "zh")).toBe("另有 1 项已完成");
  expect(doneText(2, 1, "en")).toBe("2 more are done");
  expect(doneText(1, 0, "zh")).toBe("所等的任务都已完成，可以开始了");
  expect(doneText(1, 0, "en")).toBe(
    "Everything it waits for is done — ready to start",
  );
  expect(waitersText([invite], "zh")).toBe("「Send invitations」在等它");
  expect(waitersText([invite, venue], "zh")).toBe(
    "「Send invitations」等 2 项在等它",
  );
  expect(waitersText([invite, venue], "en")).toBe(
    "“Send invitations” and 1 more are waiting for this",
  );
});

it("puts a task that waits only for another task in Waiting, and one with a stage label in its lane with that status", () => {
  const venue = task("venue", {
    title: "Book the venue",
    updatedAt: "2026-10-01T00:00:00Z",
  });
  const invite = task("invite", {
    title: "Send invitations",
    deadline: on(5),
    leadDays: 7,
    mustStart: true,
  });
  const plan = (dependencies: TaskDependency[], tasks = [venue, invite]) => ({
    tasks,
    dependencies,
    laneOrders: {},
  });
  const ids = (lanes: ReturnType<typeof boardLanes>) =>
    Object.fromEntries(
      Object.entries(lanes).map(([lane, cards]) => [
        lane,
        cards.map((card) => card.id),
      ]),
    );
  // Its deadline window is open, but an unfinished prerequisite keeps it in Waiting.
  expect(
    ids(boardLanes(plan([waitsFor("invite", "venue")]), TODAY)),
  ).toMatchObject({
    start: [],
    waiting: ["invite"],
  });
  expect(cardState(invite, TODAY, [venue])).toBe("waiting");
  expect(
    cardStatus(invite, "waiting", TODAY, "zh", [venue]).map((part) =>
      statusLine([part]),
    ),
  ).toEqual(["等「Book the venue」", "10月20日截止"]);
  // An explicit stage keeps its lane, saying what it waits for.
  const committed = {
    ...invite,
    stage: "committed" as const,
    explicitStage: "committed" as const,
  };
  const lanes = boardLanes(
    plan([waitsFor("invite", "venue")], [venue, committed]),
    TODAY,
  );
  expect(ids(lanes)).toMatchObject({ waiting: [], committed: ["invite"] });
  // Once the venue is done, the task surfaces in Parked with its deadline reason.
  expect(
    ids(
      boardLanes(
        plan([waitsFor("invite", "venue", { done: true })], [invite]),
        TODAY,
      ),
    ),
  ).toMatchObject({
    start: [],
    parked: ["invite"],
    waiting: [],
  });
  // Nor does Focus's quiet line count a task that waits.
  const due = (dependencies: TaskDependency[]) =>
    unplannedDue([venue, invite], [], TODAY, dependencies);
  expect(due([waitsFor("invite", "venue")])).toEqual({
    past: 0,
    window: 0,
    dependencies: 0,
  });
  expect(due([])).toEqual({ past: 0, window: 1, dependencies: 0 });
});

it("surfaces a task only after all of its prerequisites are done, including a recurring one still listed", () => {
  const invite = task("invite", { stage: "monthly", explicitStage: "monthly" });
  const venue = task("venue");
  const weekly = task("weekly", { recurring: true, completedCount: 4 });
  const tasks = [invite, venue, weekly];
  const show = (dependencies: TaskDependency[]) =>
    boardLanes({ tasks, dependencies, laneOrders: {} }, TODAY);

  expect(show([]).parked).toEqual([]);
  const partial = [
    waitsFor("invite", "venue", { done: true }),
    waitsFor("invite", "weekly"),
  ];
  expect(show(partial).parked).toEqual([]);
  expect(show(partial).monthly).toEqual([invite]);
  const completed = partial.map((edge) => ({ ...edge, done: true }));
  const lanes = show(completed);
  expect(lanes.parked).toEqual([invite]);
  expect(lanes.monthly).toEqual([]);
  expect(
    Object.values(lanes)
      .flat()
      .filter((item) => item.id === invite.id),
  ).toHaveLength(1);
  expect(invite).toMatchObject({ stage: "monthly", explicitStage: "monthly" });
  const index = dependencyIndex({ tasks, dependencies: completed });
  expect(index.waitingFor.has(invite.id)).toBe(false);
  expect(index.done.get(invite.id)).toHaveLength(2);
  expect(
    cardState(
      invite,
      TODAY,
      index.waitingFor.get(invite.id),
      index.done.has(invite.id),
    ),
  ).toBe("ready");
  // Completing another occurrence does not silently add a new prerequisite cycle.
  expect(show(completed).parked).toEqual([invite]);
});

it("merges a dependency write's answer, and the waiting task's new etag, without reading again", async () => {
  const data = await createPrototype().load();
  data.plan.dependencies = [waitsFor("release", "b"), waitsFor("c", "d")];
  const one = { forTask: "release", dependencies: [waitsFor("release", "e")] };
  expect(applyConfirmed(data, one).plan.dependencies).toEqual([
    waitsFor("c", "d"),
    waitsFor("release", "e"),
  ]);
  expect(applyConfirmed(data, one).plan.tasks).toBe(data.plan.tasks);
  const release = data.plan.tasks.find((item) => item.id === "release")!;
  const saved = { ...one, task: { ...release, etag: "release-2" } };
  expect(
    applyConfirmed(data, saved).plan.tasks.find((item) => item.id === "release")
      ?.etag,
  ).toBe("release-2");
  expect(rereadsAfter(one)).toBe(false);
});
