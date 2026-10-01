#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const require = createRequire(import.meta.url);
const { getComparator } = require(
  path.join(rootDir, "node_modules", "playwright-core", "lib", "server", "utils", "comparators.js")
);
const comparePng = getComparator("image/png");

// Goldens live in flowday/docs, next to the README figures, outside the Next.js app.
const goldenDir = path.join(rootDir, "..", "docs", "ui-goldens");
const currentDir = path.join(rootDir, "output", "ui-goldens", "current");
const checkMode = process.argv.includes("--check");
const skipBuild = process.argv.includes("--skip-build");
const outputDir = checkMode ? currentDir : goldenDir;
const today = "2026-04-24";
const yesterday = "2026-04-23";
const tomorrow = "2026-04-25";
const inTwoDays = "2026-04-26";
const inThreeDays = "2026-04-27";
const inOneWeek = "2026-05-01";
const miscTaskId = `__flowday_misc__:${today}`;
const screenshotInstant = `${today}T12:00:00.000Z`;
const port = Number(process.env.UI_GOLDEN_PORT ?? process.env.PLAYWRIGHT_PORT ?? 4568);
const baseURL = `http://127.0.0.1:${port}`;
const pixelThreshold = Number(process.env.UI_GOLDEN_PIXEL_THRESHOLD ?? 0.2);
const maxDiffPixelRatio = Number(process.env.UI_GOLDEN_MAX_DIFF_PIXEL_RATIO ?? 0.005);

const scenarios = [
  ["01-shell-active-light.png", "Main shell with an active timer in light mode"],
  ["02-shell-active-dark.png", "Main shell with an active timer in dark mode"],
  ["03-empty-day-canvas.png", "Empty planned day canvas after planning was dismissed"],
  ["04-planning-add-tasks.png", "Planning wizard add-task step"],
  ["05-planning-confirm-over-capacity.png", "Planning wizard capacity confirmation"],
  ["06-task-cards-and-sidebar.png", "Task card hierarchy, completed work, and sidebar sections"],
  ["07-manual-entry-popover.png", "Manual time entry popover"],
  ["08-pomodoro-picker.png", "Pomodoro preset picker"],
  ["09-popout-active.png", "Small pop-out active pomodoro state"],
  ["10-popout-paused.png", "Small pop-out paused state"],
  ["11-popout-finished.png", "Small pop-out pomodoro finished state"],
  ["12-misc-time-menu.png", "Misc time menu"],
  ["13-settings-dialog.png", "Settings dialog"],
  ["14-export-dialog.png", "Export dialog"],
  ["15-analytics-daily.png", "Analytics daily review"],
  ["16-analytics-weekly.png", "Analytics weekly review"],
  ["17-analytics-work-patterns.png", "Analytics work patterns"],
  ["18-multiday-five-day.png", "Five-day planning view"],
  ["19-sidebar-collapsed.png", "Collapsed sidebar state"],
];

const expectedImages = scenarios.map(([filename]) => filename);

function log(message) {
  console.log(`[ui-goldens] ${message}`);
}

function task(id, title, overrides = {}) {
  return {
    id,
    todoistId: overrides.todoistId ?? null,
    title,
    description: overrides.description ?? null,
    projectName: overrides.projectName ?? "FlowDay",
    projectColor: overrides.projectColor ?? "#4a9eff",
    priority: overrides.priority ?? 1,
    labels: overrides.labels ?? [],
    estimatedMins: overrides.estimatedMins ?? null,
    dueDate: overrides.dueDate ?? today,
    createdAt: overrides.createdAt ?? `${today}T09:00:00.000Z`,
    isCompleted: overrides.isCompleted ?? false,
    completedAt: overrides.completedAt ?? null,
  };
}

const baseSettings = {
  [`planning_completed:${today}`]: true,
  day_capacity_mins: 360,
};

const payloads = {
  shell: {
    tasks: [
      task("shell-focus", "Implement subtle UI polish", {
        projectName: "FlowDay",
        projectColor: "#7c3aed",
        priority: 4,
        labels: ["focus", "ui"],
        estimatedMins: 90,
      }),
      task("shell-screenshots", "Review screenshot goldens", {
        projectName: "Docs",
        projectColor: "#10b981",
        priority: 3,
        labels: ["visual"],
        estimatedMins: 45,
      }),
      task("shell-sync", "Triage Todoist sync edge case", {
        projectName: "Support",
        projectColor: "#ef4444",
        priority: 2,
        estimatedMins: 25,
      }),
      task("shell-done", "Clear morning inbox", {
        projectName: "Admin",
        projectColor: "#f59e0b",
        estimatedMins: 20,
      }),
      task("shell-pool", "Draft next refactor note", {
        projectName: "Planning",
        projectColor: "#06b6d4",
        estimatedMins: 30,
      }),
      task("shell-overdue", "Follow up on yesterday review", {
        dueDate: yesterday,
        projectName: "Review",
        projectColor: "#4a9eff",
        priority: 3,
        estimatedMins: 35,
      }),
    ],
    flows: { [today]: ["shell-focus", "shell-screenshots", "shell-sync"] },
    completedTasks: { [today]: ["shell-done"] },
    notes: [
      {
        taskId: "shell-screenshots",
        flowDate: today,
        content: "Check active, paused, pop-out, analytics, and dark mode.",
      },
    ],
    timeEntries: [
      {
        taskId: "shell-done",
        flowDate: today,
        startTime: `${today}T08:00:00.000Z`,
        endTime: `${today}T08:19:00.000Z`,
        durationS: 1140,
        source: "timer",
      },
      {
        taskId: "shell-focus",
        flowDate: today,
        startTime: `${today}T09:00:00.000Z`,
        endTime: `${today}T09:32:00.000Z`,
        durationS: 1920,
        source: "manual",
      },
    ],
    settings: baseSettings,
  },
  empty: {
    settings: baseSettings,
  },
  planning: {
    tasks: [
      task("plan-roadmap", "Review roadmap", {
        projectName: "Product",
        projectColor: "#4a9eff",
        priority: 3,
        estimatedMins: 30,
      }),
      task("plan-release", "Draft release notes", {
        projectName: "Docs",
        projectColor: "#10b981",
        labels: ["writing"],
        estimatedMins: 45,
      }),
      task("plan-bug", "Triage customer bug", {
        projectName: "Support",
        projectColor: "#ef4444",
        priority: 4,
        estimatedMins: 25,
      }),
    ],
    settings: { day_capacity_mins: 360 },
  },
  planningCapacity: {
    tasks: [
      task("plan-cap-release", "Ship the release branch", {
        projectName: "Engineering",
        projectColor: "#7c3aed",
        priority: 4,
        estimatedMins: 120,
      }),
      task("plan-cap-docs", "Write migration notes", {
        projectName: "Docs",
        projectColor: "#10b981",
        labels: ["docs"],
        estimatedMins: 90,
      }),
      task("plan-cap-review", "Review support backlog", {
        projectName: "Support",
        projectColor: "#ef4444",
        estimatedMins: 45,
      }),
    ],
    settings: { day_capacity_mins: 180 },
  },
  manual: {
    tasks: [
      task("manual-task", "Write implementation notes", {
        projectName: "Docs",
        projectColor: "#10b981",
        labels: ["docs"],
        estimatedMins: 60,
      }),
    ],
    flows: { [today]: ["manual-task"] },
    timeEntries: [
      {
        taskId: "manual-task",
        flowDate: today,
        startTime: `${today}T08:00:00.000Z`,
        endTime: `${today}T08:30:00.000Z`,
        durationS: 1800,
        source: "manual",
      },
      {
        taskId: "manual-task",
        flowDate: today,
        startTime: `${today}T09:00:00.000Z`,
        endTime: `${today}T09:22:00.000Z`,
        durationS: 1320,
        source: "timer",
      },
    ],
    settings: baseSettings,
  },
  timer: {
    tasks: [
      task("timer-focus", "Deep work on feature branch", {
        projectName: "Engineering",
        projectColor: "#7c3aed",
        priority: 4,
        labels: ["focus"],
        estimatedMins: 45,
      }),
      task("timer-next", "Write implementation notes", {
        projectName: "Docs",
        projectColor: "#10b981",
        labels: ["docs"],
        estimatedMins: 30,
      }),
    ],
    flows: { [today]: ["timer-focus", "timer-next"] },
    settings: baseSettings,
  },
  misc: {
    timeEntries: [
      {
        taskId: miscTaskId,
        flowDate: today,
        startTime: `${today}T09:00:00.000Z`,
        endTime: `${today}T09:18:00.000Z`,
        durationS: 1080,
        source: "timer",
      },
    ],
    settings: baseSettings,
  },
  settings: {
    settings: {
      ...baseSettings,
      todoist_api_key: "saved-secret-key",
      last_sync_at: `${today}T12:00:00.000Z`,
      day_capacity_mins: 300,
    },
  },
  analytics: {
    tasks: [
      task("analytics-proposal", "Write proposal", {
        projectName: "Client Work",
        projectColor: "#4a9eff",
        priority: 3,
        estimatedMins: 180,
      }),
      task("analytics-review", "Review plan", {
        projectName: "Planning",
        projectColor: "#06b6d4",
        estimatedMins: 30,
      }),
      task("analytics-bugfix", "Fix timer edge case", {
        projectName: "Engineering",
        projectColor: "#7c3aed",
        priority: 4,
        estimatedMins: 60,
      }),
      task("analytics-weekly", "Weekly planning pass", {
        dueDate: inOneWeek,
        projectName: "Planning",
        projectColor: "#06b6d4",
        estimatedMins: 45,
      }),
    ],
    flows: {
      [today]: ["analytics-proposal", "analytics-review", "analytics-bugfix"],
      [inOneWeek]: ["analytics-weekly"],
    },
    completedTasks: {
      [today]: ["analytics-review", "analytics-bugfix"],
      [inOneWeek]: ["analytics-weekly"],
    },
    timeEntries: [
      {
        taskId: "analytics-review",
        flowDate: today,
        startTime: `${today}T08:00:00.000Z`,
        endTime: `${today}T08:25:00.000Z`,
        durationS: 1500,
        source: "timer",
      },
      {
        taskId: "analytics-bugfix",
        flowDate: today,
        startTime: `${today}T09:00:00.000Z`,
        endTime: `${today}T10:15:00.000Z`,
        durationS: 4500,
        source: "timer",
      },
      {
        taskId: miscTaskId,
        flowDate: today,
        startTime: `${today}T10:30:00.000Z`,
        endTime: `${today}T10:50:00.000Z`,
        durationS: 1200,
        source: "manual",
      },
      {
        taskId: "analytics-weekly",
        flowDate: inOneWeek,
        startTime: `${inOneWeek}T11:00:00.000Z`,
        endTime: `${inOneWeek}T11:38:00.000Z`,
        durationS: 2280,
        source: "timer",
      },
    ],
    settings: baseSettings,
  },
  multiday: {
    tasks: [
      task("multi-today-a", "Today writing block", {
        projectName: "Docs",
        projectColor: "#10b981",
        labels: ["writing"],
        estimatedMins: 60,
      }),
      task("multi-today-b", "Pair review", {
        projectName: "Engineering",
        projectColor: "#7c3aed",
        estimatedMins: 30,
      }),
      task("multi-tomorrow", "Tomorrow planning pass", {
        dueDate: tomorrow,
        projectName: "Planning",
        projectColor: "#06b6d4",
        estimatedMins: 45,
      }),
      task("multi-two-days", "Research queue cleanup", {
        dueDate: inTwoDays,
        projectName: "Research",
        projectColor: "#f59e0b",
        estimatedMins: 75,
      }),
      task("multi-three-days", "Friday review block", {
        dueDate: inThreeDays,
        projectName: "Review",
        projectColor: "#ef4444",
        estimatedMins: 45,
      }),
    ],
    flows: {
      [today]: ["multi-today-a", "multi-today-b"],
      [tomorrow]: ["multi-tomorrow"],
      [inTwoDays]: ["multi-two-days"],
      [inThreeDays]: ["multi-three-days"],
    },
    completedTasks: { [tomorrow]: ["multi-tomorrow"] },
    timeEntries: [
      {
        taskId: "multi-tomorrow",
        flowDate: tomorrow,
        startTime: `${tomorrow}T16:00:00.000Z`,
        endTime: `${tomorrow}T16:32:00.000Z`,
        durationS: 1920,
        source: "timer",
      },
    ],
    settings: {
      [`planning_completed:${today}`]: true,
      [`planning_completed:${tomorrow}`]: true,
      [`planning_completed:${inTwoDays}`]: true,
      [`planning_completed:${inThreeDays}`]: true,
      day_capacity_mins: 360,
    },
  },
};

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    log(`${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      env: {
        ...process.env,
        TZ: "UTC",
        E2E_TEST_MODE: "1",
        NEXT_TELEMETRY_DISABLED: "1",
        ...options.env,
      },
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

async function buildStandalone() {
  if (skipBuild) {
    log("Skipping build because --skip-build was passed.");
  } else {
    await runCommand("npm", ["run", "build"]);
  }

  await mkdir(path.join(rootDir, ".next", "standalone", ".next"), { recursive: true });
  await cp(path.join(rootDir, "public"), path.join(rootDir, ".next", "standalone", "public"), {
    recursive: true,
  });
  await cp(
    path.join(rootDir, ".next", "static"),
    path.join(rootDir, ".next", "standalone", ".next", "static"),
    { recursive: true }
  );
}

function startServer() {
  const serverPath = path.join(rootDir, ".next", "standalone", "server.js");
  const child = spawn(process.execPath, [serverPath], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TZ: "UTC",
      E2E_TEST_MODE: "1",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/api/test/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${baseURL}: ${lastError?.message ?? "no response"}`);
}

async function seed(payload) {
  const response = await fetch(`${baseURL}/api/test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Seed failed: ${response.status} ${await response.text()}`);
  }
}

async function pageFor(browser, options = {}) {
  const theme = options.theme ?? "light";
  const localStorage = [
    { name: "flowday.idleDetectionAsked", value: "true" },
    { name: "flowday-theme", value: theme },
  ];

  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    colorScheme: theme === "dark" ? "dark" : "light",
    locale: "en-US",
    reducedMotion: "reduce",
    timezoneId: "UTC",
    storageState: {
      cookies: [],
      origins: [{ origin: baseURL, localStorage }],
    },
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(screenshotInstant);
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content: `
      html, body {
        color-scheme: ${theme === "dark" ? "dark" : "light"} !important;
        scrollbar-width: none !important;
      }
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
      ::-webkit-scrollbar {
        display: none !important;
        height: 0 !important;
        width: 0 !important;
      }
    `,
  });
  return { context, page };
}

async function screenshot(page, filename) {
  await page.screenshot({
    path: path.join(outputDir, filename),
    fullPage: false,
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
  log(`Captured ${filename}`);
}

function flowCard(page, taskId) {
  return page.locator(`[data-testid="flow-task-card"][data-task-id="${taskId}"]`);
}

async function capture(browser, filename, payload, prepare, options = {}) {
  await seed(payload);
  const { context, page } = await pageFor(browser, options);
  try {
    await prepare(page);
    await screenshot(page, filename);
  } finally {
    await context.close();
  }
}

async function startCountupTimer(page, taskId, elapsedSeconds) {
  await flowCard(page, taskId).locator('button[aria-label="Start timer"]').click();
  await page.waitForFunction(() => window.__FLOWDAY_E2E__?.getTimerState().status === "running");
  await page.evaluate(
    (seconds) => window.__FLOWDAY_E2E__.setRunningTimerElapsed(seconds),
    elapsedSeconds
  );
  await page.waitForFunction(
    (seconds) => {
      const state = window.__FLOWDAY_E2E__?.getTimerState();
      return state?.status === "running" && state.displaySeconds >= seconds;
    },
    elapsedSeconds - 1
  );
}

async function startPomodoro(page, taskId, presetText, elapsedSeconds) {
  await flowCard(page, taskId).getByTitle("Start Pomodoro").click();
  await page.getByRole("button", { name: presetText, exact: true }).click();
  await page.waitForFunction(() => window.__FLOWDAY_E2E__?.getTimerState().status === "running");
  await page.evaluate(
    (seconds) => window.__FLOWDAY_E2E__.setRunningTimerElapsed(seconds),
    elapsedSeconds
  );
}

async function mountFakePopOut(page) {
  await page.evaluate(() => window.__FLOWDAY_E2E__.mountFakePopOutWindow());
  await page.getByTestId("fake-pop-out-root").waitFor();
  await page.addStyleTag({
    content: `
      [data-testid="fake-pop-out-root"] {
        position: fixed !important;
        right: 32px !important;
        bottom: 78px !important;
        z-index: 9999 !important;
        width: 320px !important;
        height: 240px !important;
        overflow: hidden !important;
        border: 1px solid hsl(240 5.9% 90%) !important;
        border-radius: 8px !important;
        background: white !important;
        box-shadow: 0 18px 45px rgba(0, 0, 0, 0.18) !important;
      }
    `,
  });
}

async function captureAll() {
  if (checkMode) {
    await rm(currentDir, { recursive: true, force: true });
  }
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({
    args: ["--force-color-profile=srgb", "--disable-font-subpixel-positioning"],
  });
  try {
    await capture(browser, "01-shell-active-light.png", payloads.shell, async (page) => {
      await page.locator("text=Implement subtle UI polish").first().waitFor();
      await startCountupTimer(page, "shell-focus", 1110);
    });

    await capture(
      browser,
      "02-shell-active-dark.png",
      payloads.shell,
      async (page) => {
        await page.locator("text=Implement subtle UI polish").first().waitFor();
        await startCountupTimer(page, "shell-focus", 1110);
      },
      { theme: "dark" }
    );

    await capture(browser, "03-empty-day-canvas.png", payloads.empty, async (page) => {
      await page.getByTestId("day-flow-empty-state").waitFor();
    });

    await capture(browser, "04-planning-add-tasks.png", payloads.planning, async (page) => {
      await page.getByText("Start Your Day").waitFor();
      await page.locator("text=Review roadmap").first().waitFor();
    });

    await capture(
      browser,
      "05-planning-confirm-over-capacity.png",
      payloads.planningCapacity,
      async (page) => {
        await page.getByText("Start Your Day").waitFor();
        await page.getByTestId("planning-add-all").click();
        await page.getByRole("button", { name: /Continue/ }).click();
        await page.getByRole("button", { name: /Continue/ }).click();
        await page.getByText("You've planned").waitFor();
      }
    );

    await capture(browser, "06-task-cards-and-sidebar.png", payloads.shell, async (page) => {
      await page.locator("text=Implement subtle UI polish").first().waitFor();
      await page.getByRole("button", { name: /Completed\s*1/ }).click();
      await page.locator("text=Clear morning inbox").first().waitFor();
    });

    await capture(browser, "07-manual-entry-popover.png", payloads.manual, async (page) => {
      await page.locator("text=Write implementation notes").first().waitFor();
      await flowCard(page, "manual-task").getByTitle("Time entries").click();
      await page.locator("text=Time Entries").first().waitFor();
    });

    await capture(browser, "08-pomodoro-picker.png", payloads.timer, async (page) => {
      await page.locator("text=Deep work on feature branch").first().waitFor();
      await flowCard(page, "timer-focus").getByTitle("Start Pomodoro").click();
      await page.getByText("Pomodoro").waitFor();
      await page.locator('[data-testid="pomodoro-preset"]').first().waitFor();
    });

    await capture(browser, "09-popout-active.png", payloads.timer, async (page) => {
      await page.locator("text=Deep work on feature branch").first().waitFor();
      await startPomodoro(page, "timer-focus", "45m", 725);
      await mountFakePopOut(page);
      await page.locator('[data-testid="fake-pop-out-root"] >> text=Deep work on feature branch').waitFor();
    });

    await capture(browser, "10-popout-paused.png", payloads.timer, async (page) => {
      await page.locator("text=Deep work on feature branch").first().waitFor();
      await startCountupTimer(page, "timer-focus", 940);
      await mountFakePopOut(page);
      await page
        .getByTestId("fake-pop-out-root")
        .getByRole("button", { name: "Pause" })
        .click();
      await page.locator('[data-testid="fake-pop-out-root"] >> text=Paused').waitFor();
    });

    await capture(browser, "11-popout-finished.png", payloads.timer, async (page) => {
      await page.locator("text=Deep work on feature branch").first().waitFor();
      await startPomodoro(page, "timer-focus", "45m", 45 * 60);
      await mountFakePopOut(page);
      await page
        .waitForFunction(
          () => window.__FLOWDAY_E2E__?.getTimerState().pomodoroFinishedTaskId === "timer-focus"
        );
      await page.locator('[data-testid="fake-pop-out-root"] >> text=Pomodoro done').waitFor();
    });

    await capture(browser, "12-misc-time-menu.png", payloads.misc, async (page) => {
      await page.getByTestId("misc-time-trigger").click();
      await page.locator("text=Track unplanned work").first().waitFor();
    });

    await capture(browser, "13-settings-dialog.png", payloads.settings, async (page) => {
      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("heading", { name: "Settings" }).waitFor();
    });

    await capture(browser, "14-export-dialog.png", payloads.settings, async (page) => {
      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("heading", { name: "Settings" }).waitFor();
      await page.getByTestId("open-export-dialog").click();
      await page.getByRole("heading", { name: "Export Data" }).waitFor();
    });

    await capture(browser, "15-analytics-daily.png", payloads.analytics, async (page) => {
      await page.getByRole("button", { name: "Analytics" }).click();
      await page.getByRole("heading", { name: "Analytics" }).waitFor();
      await page.locator("text=Task Breakdown").first().waitFor();
    });

    await capture(browser, "16-analytics-weekly.png", payloads.analytics, async (page) => {
      await page.getByRole("button", { name: "Analytics" }).click();
      await page.getByRole("button", { name: "Weekly Review" }).click();
      await page.locator("text=Time by Project").first().waitFor();
    });

    await capture(browser, "17-analytics-work-patterns.png", payloads.analytics, async (page) => {
      await page.getByRole("button", { name: "Analytics" }).click();
      await page.getByRole("button", { name: "Work Patterns" }).click();
      await page.locator("text=Peak Work Hours").first().waitFor();
    });

    await capture(browser, "18-multiday-five-day.png", payloads.multiday, async (page) => {
      await page.getByLabel("5-day view").click();
      await page.locator("text=Friday review block").first().waitFor();
    });

    await capture(browser, "19-sidebar-collapsed.png", payloads.shell, async (page) => {
      await page.locator("text=Implement subtle UI polish").first().waitFor();
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      await page.getByRole("button", { name: "Expand sidebar" }).waitFor();
    });
  } finally {
    await browser.close();
  }
}

function readPngDimensions(buffer) {
  const pngSignature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== pngSignature) {
    throw new Error("not a PNG");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function validateScreenshots() {
  for (const image of expectedImages) {
    const goldenPath = path.join(goldenDir, image);
    const currentPath = path.join(outputDir, image);
    await stat(goldenPath);
    await stat(currentPath);
    const buffer = await readFile(checkMode ? currentPath : goldenPath);
    const dimensions = readPngDimensions(buffer);
    if (dimensions.width !== 1440 || dimensions.height !== 960) {
      throw new Error(`${image} is ${dimensions.width}x${dimensions.height}, expected 1440x960`);
    }

    if (checkMode) {
      const goldenBuffer = await readFile(goldenPath);
      const result = comparePng(buffer, goldenBuffer, {
        comparator: "pixelmatch",
        maxDiffPixelRatio,
        threshold: pixelThreshold,
      });
      if (result) {
        throw new Error(
          `${image} does not match its golden: ${result.errorMessage}. Inspect ${path.relative(
            rootDir,
            currentPath
          )}, then run npm run screenshots:ui if the UI change is intentional.`
        );
      }
    }

    log(`Verified ${path.relative(rootDir, path.join(goldenDir, image))}`);
  }
}

async function main() {
  await buildStandalone();
  const server = startServer();
  try {
    await waitForHealth();
    await captureAll();
    await validateScreenshots();
    log(checkMode ? "UI goldens match committed images." : "UI goldens are up to date.");
  } finally {
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
