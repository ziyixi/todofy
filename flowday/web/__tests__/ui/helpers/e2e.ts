import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { buildMiscTaskId } from "@/lib/utils/misc-task";
import { QUICK_TASK_PLACEHOLDER_ID } from "@/lib/utils/quick-task";

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const todayDate = new Date();
const yesterdayDate = new Date(todayDate);
yesterdayDate.setDate(yesterdayDate.getDate() - 1);
const tomorrowDate = new Date(todayDate);
tomorrowDate.setDate(tomorrowDate.getDate() + 1);
const inTwoDaysDate = new Date(todayDate);
inTwoDaysDate.setDate(inTwoDaysDate.getDate() + 2);
const inThreeDaysDate = new Date(todayDate);
inThreeDaysDate.setDate(inThreeDaysDate.getDate() + 3);
const inOneWeekDate = new Date(todayDate);
inOneWeekDate.setDate(inOneWeekDate.getDate() + 7);

export const TODAY = formatDate(todayDate);
export const YESTERDAY = formatDate(yesterdayDate);
export const TOMORROW = formatDate(tomorrowDate);
export const IN_TWO_DAYS = formatDate(inTwoDaysDate);
export const IN_THREE_DAYS = formatDate(inThreeDaysDate);
export const IN_ONE_WEEK = formatDate(inOneWeekDate);
export const FIXED_TIME_ISO = `${TODAY}T09:00:00.000Z`;

interface SeedPayload {
  tasks?: Array<{
    id: string;
    todoistId?: string | null;
    title: string;
    description?: string | null;
    projectName?: string | null;
    projectColor?: string | null;
    priority?: 1 | 2 | 3 | 4;
    labels?: string[];
    estimatedMins?: number | null;
    isCompleted?: boolean;
    completedAt?: string | null;
    dueDate?: string | null;
    createdAt?: string;
    deletedAt?: string | null;
  }>;
  flows?: Record<string, string[]>;
  completedTasks?: Record<string, string[]>;
  notes?: Array<{ taskId: string; flowDate: string; content: string }>;
  timeEntries?: Array<{
    id?: string;
    taskId: string;
    flowDate: string;
    startTime: string;
    endTime?: string | null;
    durationS?: number | null;
    source?: "timer" | "manual";
  }>;
  settings?: Record<string, string | number | boolean>;
}

export type SeedName =
  | "shell-empty"
  | "wizard-today-tasks"
  | "wizard-with-yesterday-incomplete"
  | "analytics-timezone-boundary"
  | "analytics-long-estimate"
  | "analytics-seeded-with-misc"
  | "single-flow-task"
  | "single-flow-task-with-history"
  | "future-dated-pool"
  | "two-flow-tasks"
  | "analytics-seeded"
  | "todoist-overdue"
  | "wizard-over-capacity"
  | "multi-day-readonly"
  | "sidebar-section-state"
  | "tooltip-rich-task"
  | "quick-task-group"
  | "quick-task-analytics"
  | "local-completed-yesterday"
  | "settings-saved-key"
  | "analytics-multi-date";

function localTask(
  id: string,
  title: string,
  overrides: Partial<NonNullable<SeedPayload["tasks"]>[number]> = {}
) {
  return {
    id,
    todoistId: null,
    title,
    projectName: "FlowDay",
    projectColor: "#4a9eff",
    priority: 1 as const,
    labels: [],
    dueDate: TODAY,
    createdAt: FIXED_TIME_ISO,
    ...overrides,
  };
}

function buildSeed(name: SeedName): SeedPayload {
  switch (name) {
    case "shell-empty":
      return {
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    case "wizard-today-tasks":
      return {
        tasks: [
          localTask("wizard-task-1", "Review roadmap", {
            estimatedMins: 30,
            priority: 3,
          }),
          localTask("wizard-task-2", "Draft release notes", {
            estimatedMins: 45,
          }),
        ],
        settings: {
          day_capacity_mins: 360,
        },
      };

    case "wizard-with-yesterday-incomplete":
      return {
        tasks: [
          localTask("yesterday-task-1", "Yesterday carryover", {
            dueDate: YESTERDAY,
          }),
          localTask("wizard-task-1", "Review roadmap", {
            estimatedMins: 30,
            priority: 3,
          }),
        ],
        flows: {
          [YESTERDAY]: ["yesterday-task-1"],
        },
        settings: {
          day_capacity_mins: 360,
        },
      };

    case "wizard-over-capacity":
      return {
        tasks: [
          localTask("wizard-cap-task-1", "Ship the release branch", {
            estimatedMins: 30,
            priority: 3,
          }),
          localTask("wizard-cap-task-2", "Write the migration notes", {
            estimatedMins: 45,
            labels: ["docs"],
          }),
        ],
        settings: {
          day_capacity_mins: 90,
        },
      };

    case "analytics-timezone-boundary":
      return {
        tasks: [
          localTask("analytics-tz-task", "Late-night deep work", {
            estimatedMins: 30,
          }),
        ],
        timeEntries: [
          {
            taskId: "analytics-tz-task",
            flowDate: "2026-04-12",
            startTime: "2026-04-13T00:30:00.000Z",
            endTime: "2026-04-13T01:00:00.000Z",
            durationS: 1800,
            source: "timer",
          },
        ],
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    case "analytics-long-estimate":
      return {
        tasks: [
          localTask("analytics-task-long", "Quarterly planning block", {
            estimatedMins: 300,
            priority: 3,
          }),
          localTask("analytics-task-short", "Reply to inbox", {
            estimatedMins: 30,
          }),
        ],
        flows: {
          [TODAY]: ["analytics-task-long", "analytics-task-short"],
        },
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    case "single-flow-task":
      return {
        tasks: [
          localTask("flow-task-1", "Deep work block", {
            estimatedMins: 45,
            labels: ["focus"],
          }),
        ],
        flows: {
          [TODAY]: ["flow-task-1"],
        },
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    case "single-flow-task-with-history":
      return {
        tasks: [
          localTask("flow-task-1", "Deep work block", {
            estimatedMins: 45,
            labels: ["focus"],
          }),
        ],
        flows: {
          [TODAY]: ["flow-task-1"],
        },
        timeEntries: [
          {
            taskId: "flow-task-1",
            flowDate: TODAY,
            startTime: `${TODAY}T08:00:00.000Z`,
            endTime: `${TODAY}T08:02:00.000Z`,
            durationS: 120,
            source: "timer",
          },
        ],
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    case "future-dated-pool":
      return {
        tasks: [
          localTask("future-task-2", "Plan for two days later", {
            dueDate: IN_TWO_DAYS,
            estimatedMins: 45,
          }),
          localTask("future-task-3", "Plan for three days later", {
            dueDate: IN_THREE_DAYS,
            estimatedMins: 60,
          }),
        ],
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    case "two-flow-tasks":
      return {
        tasks: [
          localTask("flow-task-a", "Inbox zero", { estimatedMins: 20 }),
          localTask("flow-task-b", "Implement feature", {
            estimatedMins: 90,
            priority: 3,
          }),
        ],
        flows: {
          [TODAY]: ["flow-task-a", "flow-task-b"],
        },
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    case "multi-day-readonly":
      return {
        tasks: [
          localTask("readonly-today", "Today writing block", {
            estimatedMins: 60,
            labels: ["writing"],
          }),
          localTask("readonly-tomorrow-done", "Tomorrow shipped task", {
            dueDate: TOMORROW,
            estimatedMins: 30,
          }),
          localTask("readonly-two-days", "Two-day planning pass", {
            dueDate: IN_TWO_DAYS,
            estimatedMins: 45,
          }),
          localTask("readonly-three-days", "Three-day research queue", {
            dueDate: IN_THREE_DAYS,
            estimatedMins: 90,
          }),
        ],
        flows: {
          [TODAY]: ["readonly-today"],
          [IN_TWO_DAYS]: ["readonly-two-days"],
          [IN_THREE_DAYS]: ["readonly-three-days"],
        },
        completedTasks: {
          [TOMORROW]: ["readonly-tomorrow-done"],
        },
        notes: [
          {
            taskId: "readonly-today",
            flowDate: TODAY,
            content: "Today note stays in today.",
          },
          {
            taskId: "readonly-tomorrow-done",
            flowDate: TOMORROW,
            content: "Tomorrow done note.",
          },
          {
            taskId: "readonly-two-days",
            flowDate: IN_TWO_DAYS,
            content: "Two-day note stays put.",
          },
        ],
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    case "sidebar-section-state":
      return {
        tasks: [
          localTask("sidebar-task-a", "Inbox zero", {
            estimatedMins: 20,
          }),
          localTask("sidebar-task-b", "Implement feature", {
            estimatedMins: 90,
            priority: 3,
          }),
          localTask("sidebar-task-c", "Closed out task", {
            estimatedMins: 30,
          }),
        ],
        flows: {
          [TODAY]: ["sidebar-task-a", "sidebar-task-b"],
        },
        completedTasks: {
          [TODAY]: ["sidebar-task-c"],
        },
        timeEntries: [
          {
            taskId: "sidebar-task-c",
            flowDate: TODAY,
            startTime: `${TODAY}T08:00:00.000Z`,
            endTime: `${TODAY}T08:25:00.000Z`,
            durationS: 1500,
            source: "timer",
          },
        ],
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    case "tooltip-rich-task":
      return {
        tasks: [
          localTask("tooltip-task", "Rich tooltip task", {
            description:
              "A markdown tooltip.\n\n- Bullet alpha\n- Bullet beta\n\nUse `npm test` before merging.",
            labels: ["urgent", "docs"],
          }),
        ],
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    case "quick-task-group":
      return {
        tasks: [
          localTask("quick-task-a", "Answer Slack ping", {
            estimatedMins: 5,
            labels: ["quick"],
          }),
          localTask("quick-task-b", "Approve invoice", {
            estimatedMins: 10,
            labels: ["Quick"],
          }),
          localTask("normal-task", "Draft roadmap section", {
            estimatedMins: 60,
            labels: ["writing"],
          }),
        ],
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    case "quick-task-analytics":
      return {
        tasks: [
          localTask("quick-task-a", "Answer Slack ping", {
            estimatedMins: 5,
            labels: ["quick"],
          }),
          localTask("quick-task-b", "Approve invoice", {
            estimatedMins: 10,
            labels: ["quick"],
          }),
        ],
        flows: {
          [TODAY]: [QUICK_TASK_PLACEHOLDER_ID],
        },
        completedTasks: {
          [TODAY]: ["quick-task-a"],
        },
        timeEntries: [
          {
            taskId: "quick-task-a",
            flowDate: TODAY,
            startTime: `${TODAY}T09:00:00.000Z`,
            endTime: `${TODAY}T09:10:00.000Z`,
            durationS: 600,
            source: "timer",
          },
        ],
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    case "local-completed-yesterday":
      return {
        tasks: [
          localTask("local-done-yesterday", "Finished local yesterday", {
            dueDate: YESTERDAY,
            estimatedMins: 15,
          }),
          localTask("local-still-overdue", "Still overdue local", {
            dueDate: YESTERDAY,
            estimatedMins: 20,
          }),
        ],
        completedTasks: {
          [YESTERDAY]: ["local-done-yesterday"],
        },
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    case "settings-saved-key":
      return {
        settings: {
          todoist_api_key: "saved-secret-key",
          last_sync_at: `${TODAY}T12:00:00.000Z`,
          day_capacity_mins: 210,
          [`planning_completed:${TODAY}`]: true,
        },
      };

    case "analytics-seeded":
      return {
        tasks: [
          localTask("analytics-task-1", "Write proposal", {
            estimatedMins: 180,
            priority: 3,
          }),
          localTask("analytics-task-2", "Review plan", {
            estimatedMins: 30,
          }),
        ],
        flows: {
          [TODAY]: ["analytics-task-1", "analytics-task-2"],
        },
        completedTasks: {
          [TODAY]: ["analytics-task-2"],
        },
        timeEntries: [
          {
            taskId: "analytics-task-2",
            flowDate: TODAY,
            startTime: `${TODAY}T08:00:00.000Z`,
            endTime: `${TODAY}T08:25:00.000Z`,
            durationS: 1500,
            source: "timer",
          },
        ],
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };
    case "analytics-seeded-with-misc":
      return {
        tasks: [
          localTask("analytics-task-1", "Write proposal", {
            estimatedMins: 180,
            priority: 3,
          }),
          localTask("analytics-task-2", "Review plan", {
            estimatedMins: 30,
          }),
        ],
        flows: {
          [TODAY]: ["analytics-task-1", "analytics-task-2"],
        },
        completedTasks: {
          [TODAY]: ["analytics-task-2"],
        },
        timeEntries: [
          {
            taskId: "analytics-task-2",
            flowDate: TODAY,
            startTime: `${TODAY}T08:00:00.000Z`,
            endTime: `${TODAY}T08:25:00.000Z`,
            durationS: 1500,
            source: "timer",
          },
          {
            taskId: buildMiscTaskId(TODAY),
            flowDate: TODAY,
            startTime: `${TODAY}T09:00:00.000Z`,
            endTime: `${TODAY}T09:20:00.000Z`,
            durationS: 1200,
            source: "timer",
          },
        ],
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    case "analytics-multi-date":
      return {
        tasks: [
          localTask("analytics-multi-today", "Today review block", {
            estimatedMins: 60,
            projectName: "Today Project",
          }),
          localTask("analytics-multi-next-week", "Next week planning block", {
            dueDate: IN_ONE_WEEK,
            estimatedMins: 30,
            projectName: "Next Week Project",
          }),
        ],
        flows: {
          [TODAY]: ["analytics-multi-today"],
          [IN_ONE_WEEK]: ["analytics-multi-next-week"],
        },
        completedTasks: {
          [TODAY]: ["analytics-multi-today"],
          [IN_ONE_WEEK]: ["analytics-multi-next-week"],
        },
        timeEntries: [
          {
            taskId: "analytics-multi-today",
            flowDate: TODAY,
            startTime: `${TODAY}T09:00:00.000Z`,
            endTime: `${TODAY}T09:30:00.000Z`,
            durationS: 1800,
            source: "timer",
          },
          {
            taskId: "analytics-multi-next-week",
            flowDate: IN_ONE_WEEK,
            startTime: `${IN_ONE_WEEK}T10:00:00.000Z`,
            endTime: `${IN_ONE_WEEK}T10:20:00.000Z`,
            durationS: 1200,
            source: "timer",
          },
        ],
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };
    case "todoist-overdue":
      // Two Todoist-sourced overdue tasks. The UI test deletes one in
      // Todoist (simulated via /api/test/sync-orphans) and verifies it
      // disappears from the sidebar while the other stays put.
      return {
        tasks: [
          localTask("td-keep", "Survives sync", {
            todoistId: "td-keep",
            dueDate: YESTERDAY,
            estimatedMins: 25,
          }),
          localTask("td-deleted", "Deleted in Todoist", {
            todoistId: "td-deleted",
            dueDate: YESTERDAY,
            estimatedMins: 15,
          }),
        ],
        settings: {
          [`planning_completed:${TODAY}`]: true,
          day_capacity_mins: 360,
        },
      };

    default:
      throw new Error(`Unknown seed "${name}"`);
  }
}

export async function resetAppState(request: APIRequestContext) {
  const response = await request.post("/api/test/reset");
  expect(response.ok()).toBeTruthy();
}

export async function seedAppState(request: APIRequestContext, name: SeedName) {
  const response = await request.post("/api/test/seed", {
    data: buildSeed(name),
  });
  expect(response.ok()).toBeTruthy();
}

export async function simulateTodoistOrphanSweep(
  request: APIRequestContext,
  activeTodoistIds: string[]
) {
  const response = await request.post("/api/test/sync-orphans", {
    data: { activeTodoistIds },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

export async function installFixedClock(page: Page) {
  await page.clock.install({ time: new Date(FIXED_TIME_ISO) });
}

export async function waitForFlowdayE2EBridge(page: Page) {
  await page.waitForFunction(
    () => Boolean(window.__FLOWDAY_E2E__),
    undefined,
    { timeout: 10_000 }
  );
}

export async function setRunningTimerElapsed(page: Page, seconds: number) {
  await waitForFlowdayE2EBridge(page);
  await page.evaluate((elapsedSeconds) => {
    const bridge = window.__FLOWDAY_E2E__;
    if (!bridge) throw new Error("FlowDay E2E bridge is not installed");
    bridge.setRunningTimerElapsed(elapsedSeconds);
  }, seconds);
}

export async function getTimerState(page: Page) {
  await waitForFlowdayE2EBridge(page);
  return page.evaluate(() => {
    const bridge = window.__FLOWDAY_E2E__;
    if (!bridge) throw new Error("FlowDay E2E bridge is not installed");
    return bridge.getTimerState();
  });
}

export async function primeFakePopOutWindow(page: Page) {
  await waitForFlowdayE2EBridge(page);
  await page.evaluate(() => {
    const bridge = window.__FLOWDAY_E2E__;
    if (!bridge) throw new Error("FlowDay E2E bridge is not installed");
    bridge.primeFakePopOutWindow();
  });
}

export async function mountFakePopOutWindow(page: Page) {
  await waitForFlowdayE2EBridge(page);
  await page.evaluate(() => {
    const bridge = window.__FLOWDAY_E2E__;
    if (!bridge) throw new Error("FlowDay E2E bridge is not installed");
    bridge.mountFakePopOutWindow();
  });
}

export async function restartFinishedPomodoroWithGap(
  page: Page,
  targetSeconds: number,
  gapMs = 100
) {
  await waitForFlowdayE2EBridge(page);
  await page.evaluate(
    ({ seconds, delay }) => {
      const bridge = window.__FLOWDAY_E2E__;
      if (!bridge) throw new Error("FlowDay E2E bridge is not installed");
      bridge.restartFinishedPomodoroWithGap(seconds, delay);
    },
    { seconds: targetSeconds, delay: gapMs }
  );
}

export async function getPopOutState(page: Page) {
  await waitForFlowdayE2EBridge(page);
  return page.evaluate(() => {
    const bridge = window.__FLOWDAY_E2E__;
    if (!bridge) throw new Error("FlowDay E2E bridge is not installed");
    return bridge.getPopOutState();
  });
}

export async function getChimeCount(page: Page): Promise<number> {
  await waitForFlowdayE2EBridge(page);
  return page.evaluate(() => {
    const bridge = window.__FLOWDAY_E2E__;
    if (!bridge) throw new Error("FlowDay E2E bridge is not installed");
    return bridge.getChimeCount();
  });
}

export async function resetChimeCount(page: Page) {
  await waitForFlowdayE2EBridge(page);
  await page.evaluate(() => {
    const bridge = window.__FLOWDAY_E2E__;
    if (!bridge) throw new Error("FlowDay E2E bridge is not installed");
    bridge.resetChimeCount();
  });
}

export async function simulateIdleAway(page: Page, secondsAgo: number) {
  await waitForFlowdayE2EBridge(page);
  await page.evaluate(
    (s) => {
      const bridge = window.__FLOWDAY_E2E__;
      if (!bridge) throw new Error("FlowDay E2E bridge is not installed");
      bridge.simulateIdleAway(s);
    },
    secondsAgo
  );
}

export async function openApp(page: Page) {
  // Idle-permission banner is `position: fixed` over the header and renders
  // after an async permissions.query, so a post-load dismiss races the banner
  // and leaves it intercepting clicks on the date-nav arrows. Pre-seed the
  // "already asked" flag so the banner never mounts.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flowday.idleDetectionAsked", "true");
    } catch {
      // ignore — Safari private mode etc.
    }
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "FlowDay" })).toBeVisible();
}

export function flowCard(page: Page, title: string): Locator {
  return page.locator('[data-testid="flow-task-card"]', {
    has: page.getByText(title, { exact: true }),
  });
}

export function flowCardById(page: Page, taskId: string): Locator {
  return page.locator(`[data-testid="flow-task-card"][data-task-id="${taskId}"]`);
}

export function completedRow(page: Page, title: string): Locator {
  return page.locator('[data-testid="completed-task-row"]', {
    has: page.getByText(title, { exact: true }),
  });
}

export function taskPoolCard(page: Page, title: string): Locator {
  return page.locator('[data-testid="task-pool-card"]', {
    has: page.getByText(title, { exact: true }),
  });
}

export async function dragTaskToEmptyFlow(page: Page, title: string) {
  const source = taskPoolCard(page, title);
  const target = page.getByTestId("day-flow-empty-state");
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();

  if (!sourceBox || !targetBox) {
    throw new Error("Unable to resolve drag source or target bounds");
  }

  await page.mouse.move(
    sourceBox.x + 28,
    sourceBox.y + sourceBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    sourceBox.x + 64,
    sourceBox.y + sourceBox.height / 2 + 8,
    { steps: 6 }
  );
  await page.mouse.move(
    targetBox.x + targetBox.width * 0.35,
    targetBox.y + targetBox.height * 0.28,
    { steps: 16 }
  );
  await page.mouse.up();
}

export async function dragFlowCardToFlowCard(
  page: Page,
  sourceTaskId: string,
  targetTaskId: string
) {
  const source = flowCardById(page, sourceTaskId);
  const target = flowCardById(page, targetTaskId);
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();

  if (!sourceBox || !targetBox) {
    throw new Error("Unable to resolve flow card drag bounds");
  }

  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 3,
    { steps: 16 }
  );
  await page.mouse.up();
}
