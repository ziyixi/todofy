import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addDays } from "../src/domain";
import { unplannedDue } from "../src/deadlines";
import {
  candidates,
  dependencyIndex,
  doneText,
  droppedText,
  holds,
  releasedText,
  unsettled,
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
const managedLabels = [
  "office",
  "home",
  "quarter",
  "candiate",
  "focus",
  "committed",
].map((role) => ({ role, id: role, label: role }));
const task = (id: string, value: Partial<PlanningTask> = {}): PlanningTask => ({
  id,
  title: `Synthetic ${id}`,
  parentId: "",
  projectId: "synthetic",
  labels: [],
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
  baselineCount: 0,
  done: false,
  ...value,
});

it("holds while the prerequisite is listed, and a recurring one until its next completion", () => {
  const edge = waitsFor("a", "b", { baselineCount: 3 });
  expect(holds(edge, task("b"))).toBe(true);
  // Missing from a complete read: done, completed or deleted alike.
  expect(holds(edge, undefined)).toBe(false);
  expect(holds({ ...edge, done: true }, undefined)).toBe(false);
  const recurring = (completedCount?: number) =>
    task("b", { recurring: true, completedCount });
  expect(holds(edge, recurring(3))).toBe(true);
  expect(holds(edge, recurring(4))).toBe(false);
  // An undone completion lowers the counter: the task waits again.
  expect(holds(edge, recurring(3))).toBe(true);
  // Without Todoist's counter there is no telling: it keeps waiting.
  expect(holds(edge, recurring(undefined))).toBe(true);
  // A reopened one-off task waits again, whatever Todofy recorded before.
  expect(holds({ ...edge, done: true }, task("b"))).toBe(true);
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
    waitsFor("invite", "weekly", { baselineCount: 1 }),
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
    task("label", { labels: ["waiting"], updatedAt: "2026-10-10T00:00:00Z" }),
    task("dependent", { updatedAt: "2026-10-01T00:00:00Z" }),
    task("venue", { updatedAt: "2026-09-01T00:00:00Z" }),
    task("unknown", { labels: ["blocked"] }),
  ];
  expect(
    waitingTasks({ tasks, dependencies: [waitsFor("dependent", "venue")] }).map(
      (item) => item.id,
    ),
  ).toEqual(["dependent", "label", "unknown"]);
});

it("detects a cycle through other tasks as Todofy does", () => {
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
    task("review", { title: "Weekly launch review", recurring: true }),
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
    ["review", "repeats"],
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
  // The sync's count passed the baseline: done, so it can be chosen to wait for its next completion.
  expect(shown([waitsFor("report", "sync", { baselineCount: 4 })])).toEqual([
    ["sync", ""],
    ["draft", ""],
  ]);
  expect(shown([waitsFor("report", "sync", { baselineCount: 5 })])).toEqual([
    ["draft", ""],
  ]);
  // The draft once waited for the report through the sync, which is done: no cycle any more.
  const through = [
    waitsFor("draft", "sync", { baselineCount: 4 }),
    waitsFor("sync", "report"),
  ];
  expect(shown(through, report, "dra")).toEqual([["draft", ""]]);
  expect(shown([waitsFor("draft", "report")], report, "dra")).toEqual([
    ["draft", "cycle"],
  ]);
});

it("names the tasks a complete read misses for Todofy to settle, gone waiters first, at most twenty", () => {
  const tasks = [task("invite"), task("venue"), task("reopened")];
  expect(
    unsettled({
      tasks,
      dependencies: [
        waitsFor("invite", "venue"),
        waitsFor("invite", "completed", { done: true }),
        waitsFor("invite", "deleted"),
        waitsFor("finished", "venue"),
        // Recorded completed, yet listed again: reopened, so that a later deletion is settled too.
        waitsFor("invite", "reopened", { done: true }),
      ],
    }),
  ).toEqual(["finished", "deleted", "reopened"]);
  const many = Array.from({ length: 25 }, (_, n) => waitsFor(`w${n}`, "venue"));
  expect(unsettled({ tasks, dependencies: many })).toHaveLength(20);
  // Review finding: the ones asked already in this visit leave room for the rest, so none starves.
  const stuck = Array.from({ length: 21 }, (_, n) =>
    waitsFor("invite", `gone-${n}`),
  );
  const first = unsettled({ tasks, dependencies: stuck });
  expect(unsettled({ tasks, dependencies: stuck }, new Set(first))).toEqual([
    "gone-20",
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
  expect(droppedText(invite, "zh")).toBe(
    "「Send invitations」等的任务已被删除，不再等待。",
  );
  expect(droppedText(invite, "en")).toBe(
    "“Send invitations” no longer waits — the task it waited for was deleted.",
  );
  expect(releasedText(invite, "zh")).toBe(
    "「Send invitations」等的任务已不在待办中，不再等待。",
  );
  expect(releasedText(invite, "en")).toBe(
    "“Send invitations” no longer waits — the task it waited for is no longer active.",
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
    managedLabels,
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
  // It would start (its window is open), but it waits: Waiting, not Start now.
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
  // An explicit stage label keeps its lane, saying what it waits for.
  const committed = {
    ...invite,
    stage: "committed" as const,
    labels: ["committed"],
  };
  const lanes = boardLanes(
    plan([waitsFor("invite", "venue")], [venue, committed]),
    TODAY,
  );
  expect(ids(lanes)).toMatchObject({ waiting: [], committed: ["invite"] });
  // Once the venue is gone from the list (completed or deleted), the task is ready: Start now again.
  expect(
    ids(
      boardLanes(
        plan([waitsFor("invite", "venue", { done: true })], [invite]),
        TODAY,
      ),
    ),
  ).toMatchObject({
    start: ["invite"],
    waiting: [],
  });
  // Nor does Focus's quiet line count a task that waits.
  const due = (dependencies: TaskDependency[]) =>
    unplannedDue([venue, invite], [], TODAY, dependencies);
  expect(due([waitsFor("invite", "venue")])).toEqual({ past: 0, window: 0 });
  expect(due([])).toEqual({ past: 0, window: 1 });
});

it("merges a dependency write's answer without reading again", async () => {
  const data = await createPrototype().load();
  data.plan.dependencies = [waitsFor("a", "b"), waitsFor("c", "d")];
  const one = { forTask: "a", dependencies: [waitsFor("a", "e")] };
  expect(applyConfirmed(data, one).plan.dependencies).toEqual([
    waitsFor("c", "d"),
    waitsFor("a", "e"),
  ]);
  const every = {
    dependencies: [waitsFor("c", "d", { done: true })],
    dropped: ["a"],
  };
  expect(applyConfirmed(data, every).plan.dependencies).toEqual(
    every.dependencies,
  );
  expect(applyConfirmed(data, one).plan.tasks).toBe(data.plan.tasks);
  expect(rereadsAfter(one) || rereadsAfter(every)).toBe(false);
});
