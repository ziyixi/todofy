import { expect, it } from "vitest";
import {
  apiPriority,
  categoryLabels,
  categoryName,
  deletionBatch,
  MAIL_BATCH,
  mailboxCandidates,
  mailboxRows,
  mailTime,
  recheckedBatch,
  rowName,
  summaryParagraphs,
  touched,
  type PlanContext,
} from "../src/mail";
import { pendingTask } from "../src/plan-updates";
import { inboxToClarify } from "../src/weekly-review";
import type { MailItem, PlanState, PlanningTask } from "../src/model";

const task = (
  id: string,
  fields: Partial<PlanningTask> = {},
): PlanningTask => ({
  id,
  title: `Synthetic ${id}`,
  parentId: "",
  projectId: "mail",
  labels: [],
  area: "unassigned",
  stage: "none",
  priority: 1,
  deadline: "",
  due: "",
  leadDays: 0,
  etag: `${id}-1`,
  mustStart: false,
  missingLead: false,
  ...fields,
});
const item = (taskId: string, receivedAt: string): MailItem => ({
  id: `event-${taskId}`,
  taskId,
  brief: `Brief of ${taskId}.`,
  receivedAt,
  hasSummary: true,
});
const plan = (tasks: PlanningTask[]): PlanState => ({
  tasks,
  week: "2026-10-12",
  timezone: "UTC",
  configured: true,
  hiddenFilterIds: [],
  flowdayUrl: "",
  managedLabelNames: [],
  managedLabels: [
    { role: "office", id: "l-office", label: "office" },
    { role: "home", id: "l-home", label: "home" },
    { role: "committed", id: "l-committed", label: "committed" },
    { role: "bets", id: "l-bets", label: "bets" },
    { role: "lead_1w", id: "l-lead", label: "lead_1w" },
  ],
  etag: "plan",
  availableLabels: [
    { id: "l-office", label: "office" },
    { id: "l-home", label: "home" },
    { id: "l-committed", label: "committed" },
    { id: "l-bets", label: "bets" },
    { id: "l-lead", label: "lead_1w" },
    { id: "l-active", label: "active" },
    { id: "l-quick", label: "quick" },
    { id: "l-reading", label: "reading" },
  ],
  inboxProjectId: "mail",
  reviewTaskId: "review",
  nextWeekTaskIds: [],
  dependencies: [],
  weeklyBets: [],
});
const idle = (fields: Partial<PlanContext> = {}): PlanContext => ({
  tasks: [],
  days: [],
  focus: {
    date: "2026-10-16",
    taskIds: [],
    completedTaskIds: [],
    timerEtag: "0",
    estimates: {},
    flowTasks: {},
  },
  pending: new Set(),
  dependencies: [],
  ...fields,
});

it("lists the weekly review's mail to clarify that Todofy knows as mail, newest first", () => {
  const state = plan([
    task("old"),
    task("new"),
    task("own"), // the owner's own task in the mail project: not mail
    task("review"), // the weekly review task
    task("step", { parentId: "old" }),
    task("quick", { labels: ["quick"] }),
    task("staged", { stage: "committed" }),
    task("elsewhere", { projectId: "work" }),
  ]);
  const candidates = mailboxCandidates(state);
  expect(candidates.map((candidate) => candidate.id)).toEqual([
    "old",
    "new",
    "own",
  ]);
  const { rows, others } = mailboxRows(
    candidates,
    new Map([
      ["old", item("old", "2026-10-14T08:00:00.000Z")],
      ["new", item("new", "2026-10-16T09:42:00.000Z")],
      ["own", null],
    ]),
  );
  expect(rows.map((row) => row.task.id)).toEqual(["new", "old"]);
  // The list and the other tasks together are the review's count.
  expect(rows.length + others).toBe(inboxToClarify(state).length);
});

it("keeps a mail on Delete all once the owner changed or planned it in any way", () => {
  expect(touched(task("plain"), idle())).toBe(false);
  const changes: [Partial<PlanningTask>, Partial<PlanContext>][] = [
    [{ labels: ["reading"] }, {}],
    [{ priority: 2 }, {}],
    [{ due: "2026-10-20" }, {}],
    [{ deadline: "2026-10-30" }, {}],
    [{ estimatedMinutes: 15 }, {}],
    [{}, { tasks: [task("child", { parentId: "plain" })] }],
    // A dependency either way, done or not, as Todofy keeps it (plan_edges).
    [
      {},
      {
        dependencies: [
          {
            taskId: "plain",
            prerequisiteId: "other",
            baselineCount: 0,
            done: false,
          },
        ],
      },
    ],
    [
      {},
      {
        dependencies: [
          {
            taskId: "other",
            prerequisiteId: "plain",
            baselineCount: 0,
            done: true,
          },
        ],
      },
    ],
    [
      {},
      {
        days: [
          { date: "2026-10-17", taskIds: ["plain"], completedTaskIds: [] },
        ],
      },
    ],
    [{}, { focus: { ...idle().focus, taskIds: ["plain"] } }],
    [
      {},
      {
        focus: {
          ...idle().focus,
          timer: {
            taskId: "plain",
            flowDate: "2026-10-16",
            status: "running",
            elapsedSeconds: 0,
            startedAt: "2026-10-16T09:00:00Z",
            etag: "1",
          },
        },
      },
    ],
    [{}, { pending: new Set([pendingTask("plain")]) }],
  ];
  for (const [fields, context] of changes)
    expect(touched(task("plain", fields), idle(context))).toBe(true);
});

it("freezes the oldest untouched mail, at most 200, and names the kept rows", () => {
  const rows = Array.from({ length: MAIL_BATCH + 3 }, (_, index) => ({
    task: task(`m${index}`, index === 1 ? { labels: ["reading"] } : {}),
    // Newest first, as the list shows them.
    mail: item(
      `m${index}`,
      new Date(Date.UTC(2026, 9, 16) - index * 60_000).toISOString(),
    ),
  }));
  const batch = deletionBatch(rows, (candidate) => candidate.labels.length > 0);
  expect(batch.kept.map((row) => row.task.id)).toEqual(["m1"]);
  expect(batch.taskIds).toHaveLength(MAIL_BATCH);
  expect(batch.taskIds[0]).toBe(`m${MAIL_BATCH + 2}`); // the oldest goes first
  expect(batch.taskIds).not.toContain("m1");
  // 202 untouched: the two newest wait for the next Delete all.
  expect(batch.later).toBe(2);
  expect(batch.taskIds).not.toContain("m0");
});

it("rechecks the frozen batch before sending: a mail touched since leaves it, and none is added", () => {
  const tasks = [
    task("a"),
    task("b", { estimatedMinutes: 25 }),
    task("c"),
    task("new"),
  ];
  const isTouched = (candidate: PlanningTask) =>
    Boolean(candidate.estimatedMinutes) || candidate.id === "c";
  const now = recheckedBatch(["a", "b", "c", "gone"], tasks, isTouched);
  // "gone" is no longer listed: it stays for Todofy, which counts it deleted once it finds it nowhere.
  expect(now.taskIds).toEqual(["a", "gone"]);
  expect(now.touched.map((candidate) => candidate.id)).toEqual(["b", "c"]);
  expect(recheckedBatch(["a"], tasks, isTouched)).toEqual({
    taskIds: ["a"],
    touched: [],
  });
});

it("tells the time a mail arrived as Todoist does, in the account's time zone", () => {
  const today = "2026-10-16";
  const at = (iso: string, language: "zh" | "en" = "zh") =>
    mailTime(iso, "America/Los_Angeles", today, language);
  // 16:42 UTC is 09:42 in Los Angeles on Friday the 16th.
  expect(at("2026-10-16T16:42:00Z")).toEqual({
    short: "09:42",
    full: "10月16日周五 09:42",
  });
  expect(at("2026-10-16T16:42:00Z", "en")).toEqual({
    short: "09:42",
    full: "Fri, Oct 16, 09:42",
  });
  // 06:00 UTC on the 16th is still the 15th there: yesterday.
  expect(at("2026-10-16T06:00:00Z").short).toBe("昨天");
  expect(at("2026-10-16T06:00:00Z", "en").short).toBe("Yesterday");
  expect(at("2026-10-13T18:00:00Z").short).toBe("周二");
  expect(at("2026-10-10T18:00:00Z", "en").short).toBe("Sat");
  expect(at("2026-10-09T18:00:00Z").short).toBe("10月9日");
  expect(at("2026-10-09T18:00:00Z", "en").short).toBe("Oct 9");
  expect(at("2025-12-03T22:02:00Z")).toEqual({
    short: "2025年12月3日",
    full: "2025年12月3日周三 14:02",
  });
  expect(at("2025-12-03T22:02:00Z", "en")).toEqual({
    short: "Dec 3, 2025",
    full: "Wed, Dec 3, 2025, 14:02",
  });
});

it("shows a summary as plain paragraphs, never as markup", () => {
  expect(
    summaryParagraphs(
      "体检定在 **10月28日**。\n\n## 体检安排\n- 地点：`3 楼`\n- 带 __身份证__\n\n\n<b>不是 HTML</b> https://example.test",
    ),
  ).toEqual([
    ["体检定在 10月28日。"],
    ["体检安排", "- 地点：3 楼", "- 带 身份证"],
    ["<b>不是 HTML</b> https://example.test"],
  ]);
  expect(summaryParagraphs(" \n\n")).toEqual([]);
});

it("offers the area labels by their names first, never one Plus writes by other means", () => {
  const labels = categoryLabels(plan([]), { work: "工作", personal: "生活" });
  expect(labels).toEqual([
    { id: "l-office", name: "工作" },
    { id: "l-home", name: "生活" },
    { id: "l-quick", name: "quick" },
    { id: "l-reading", name: "reading" },
  ]);
  expect(categoryName({ labelId: "l-office", priority: 2 }, labels)).toBe(
    "工作 · P2",
  );
  expect(categoryName({ labelId: "l-quick", priority: 4 }, labels)).toBe(
    "quick · P4",
  );
  expect(
    categoryName({ labelId: "gone", priority: 1 }, labels),
  ).toBeUndefined();
});

it("speaks one priority vocabulary and names a row by what it shows", () => {
  expect([1, 2, 3, 4].map(apiPriority)).toEqual([4, 3, 2, 1]);
  const row = {
    task: task("t", { title: "[TASK] Invoice" }),
    mail: item("t", ""),
  };
  // The brief's closing punctuation goes before the comma: never "。，09:42".
  expect(rowName(row, "09:42", "zh")).toBe("Invoice，Brief of t，09:42");
  const zh = {
    ...row,
    mail: { ...row.mail, brief: "10 月账单 ¥128，无需操作。" },
  };
  expect(rowName(zh, "09:42", "zh")).toBe(
    "Invoice，10 月账单 ¥128，无需操作，09:42",
  );
  expect(
    rowName({ ...row, mail: { ...row.mail, brief: "" } }, "Yesterday", "en"),
  ).toBe("Invoice, Yesterday");
});
