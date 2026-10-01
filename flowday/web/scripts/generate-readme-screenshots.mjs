#!/usr/bin/env node

import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { prepareE2E, startE2EWorker, waitForE2E } from "./e2e-server.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// The Next.js app lives in flowday/web; README.md and its figures live one level up in flowday/.
const rootDir = path.resolve(scriptDir, "..");
const docsRootDir = path.resolve(rootDir, "..");
const require = createRequire(import.meta.url);
const { getComparator } = require(
  path.join(rootDir, "node_modules", "playwright-core", "lib", "server", "utils", "comparators.js")
);
const comparePng = getComparator("image/png");
const goldenDir = path.join(docsRootDir, "docs", "readme");
const currentDir = path.join(rootDir, "output", "readme-screenshots", "current");
const outputDir = process.argv.includes("--check") ? currentDir : goldenDir;
const today = "2026-04-24";
const tomorrow = "2026-04-25";
const inTwoDays = "2026-04-26";
const screenshotInstant = `${today}T12:00:00.000Z`;
const port = Number(process.env.README_SCREENSHOT_PORT ?? process.env.PLAYWRIGHT_PORT ?? 4567);
const baseURL = `http://127.0.0.1:${port}`;
const skipBuild = process.argv.includes("--skip-build");
const checkMode = process.argv.includes("--check");
const pixelThreshold = Number(process.env.README_SCREENSHOT_PIXEL_THRESHOLD ?? 0.2);
const maxDiffPixelRatio = Number(process.env.README_SCREENSHOT_MAX_DIFF_PIXEL_RATIO ?? 0.005);

const expectedImages = [
  "flowday-main.png",
  "flowday-planning.png",
  "flowday-drag.png",
  "flowday-reorder.png",
  "flowday-timer.png",
  "flowday-popout.png",
  "flowday-multiday.png",
  "flowday-analytics.png",
];

function log(message) {
  console.log(`[readme-screenshots] ${message}`);
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
  main: {
    tasks: [
      task("demo-brief", "Review launch notes", {
        todoistId: "td-demo-brief",
        projectName: "Product",
        projectColor: "#4a9eff",
        priority: 3,
        labels: ["review"],
        estimatedMins: 30,
      }),
      task("demo-build", "Implement onboarding polish", {
        todoistId: "td-demo-build",
        projectName: "FlowDay",
        projectColor: "#7c3aed",
        priority: 4,
        labels: ["focus"],
        estimatedMins: 90,
      }),
      task("demo-write", "Write README quick start", {
        projectName: "Docs",
        projectColor: "#10b981",
        priority: 2,
        labels: ["docs"],
        estimatedMins: 45,
      }),
      task("demo-inbox", "Clear morning inbox", {
        projectName: "Admin",
        projectColor: "#f59e0b",
        estimatedMins: 25,
        createdAt: `${today}T08:00:00.000Z`,
      }),
      task("demo-side-sync", "Sync Todoist and pick tomorrow tasks", {
        todoistId: "td-demo-side-sync",
        projectName: "Planning",
        projectColor: "#06b6d4",
        priority: 2,
        labels: ["setup"],
        estimatedMins: 20,
      }),
      task("demo-side-review", "Review analytics after work", {
        todoistId: "td-demo-side-review",
        projectName: "Review",
        projectColor: "#ef4444",
        labels: ["later"],
        estimatedMins: 30,
      }),
    ],
    flows: { [today]: ["demo-brief", "demo-build", "demo-write"] },
    completedTasks: { [today]: ["demo-inbox"] },
    timeEntries: [
      {
        taskId: "demo-inbox",
        flowDate: today,
        startTime: `${today}T15:00:00.000Z`,
        endTime: `${today}T15:22:00.000Z`,
        durationS: 1320,
        source: "timer",
      },
    ],
    settings: baseSettings,
  },
  planning: {
    tasks: [
      task("plan-roadmap", "Review roadmap", {
        todoistId: "td-plan-roadmap",
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
        todoistId: "td-plan-bug",
        projectName: "Support",
        projectColor: "#ef4444",
        priority: 4,
        estimatedMins: 25,
      }),
    ],
    settings: { day_capacity_mins: 360 },
  },
  drag: {
    tasks: [
      task("drag-task", "Drag this task into today", {
        projectName: "Planning",
        projectColor: "#06b6d4",
        priority: 3,
        estimatedMins: 35,
      }),
      task("drag-next", "Estimate README polish", {
        projectName: "Docs",
        projectColor: "#10b981",
        estimatedMins: 45,
      }),
    ],
    settings: baseSettings,
  },
  reorder: {
    tasks: [
      task("reorder-a", "Review launch notes", {
        projectName: "Product",
        projectColor: "#4a9eff",
        priority: 3,
        estimatedMins: 30,
      }),
      task("reorder-b", "Fix screenshot script", {
        projectName: "Engineering",
        projectColor: "#7c3aed",
        priority: 4,
        estimatedMins: 75,
      }),
      task("reorder-c", "Polish README tour", {
        projectName: "Docs",
        projectColor: "#10b981",
        labels: ["docs"],
        estimatedMins: 45,
      }),
    ],
    flows: { [today]: ["reorder-a", "reorder-b", "reorder-c"] },
    settings: baseSettings,
  },
  timer: {
    tasks: [
      task("timer-focus", "Deep work on feature branch", {
        projectName: "Engineering",
        projectColor: "#7c3aed",
        priority: 4,
        labels: ["focus"],
        estimatedMins: 90,
      }),
      task("timer-notes", "Write implementation notes", {
        projectName: "Docs",
        projectColor: "#10b981",
        labels: ["docs"],
        estimatedMins: 30,
      }),
    ],
    flows: { [today]: ["timer-focus", "timer-notes"] },
    settings: baseSettings,
  },
  popout: {
    tasks: [
      task("pip-focus", "Draft the launch update", {
        projectName: "Product",
        projectColor: "#4a9eff",
        priority: 4,
        labels: ["focus"],
        estimatedMins: 45,
      }),
      task("pip-next", "Review analytics notes", {
        projectName: "Review",
        projectColor: "#ef4444",
        estimatedMins: 30,
      }),
    ],
    flows: { [today]: ["pip-focus", "pip-next"] },
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
    ],
    flows: {
      [today]: ["multi-today-a", "multi-today-b"],
      [tomorrow]: ["multi-tomorrow"],
      [inTwoDays]: ["multi-two-days"],
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
      day_capacity_mins: 360,
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
    ],
    flows: { [today]: ["analytics-proposal", "analytics-review", "analytics-bugfix"] },
    completedTasks: { [today]: ["analytics-review", "analytics-bugfix"] },
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
    ],
    settings: baseSettings,
  },
};

// The E2E export under `wrangler dev` with a fresh local D1 (scripts/e2e-server.mjs).
async function startApp() {
  await prepareE2E({ skipBuild });
  return startE2EWorker(port);
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

async function pageFor(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "en-US",
    reducedMotion: "reduce",
    timezoneId: "UTC",
    storageState: {
      cookies: [],
      origins: [
        {
          origin: baseURL,
          localStorage: [{ name: "flowday.idleDetectionAsked", value: "true" }],
        },
      ],
    },
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(screenshotInstant);
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content: `
      html, body {
        color-scheme: light !important;
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

async function capture(browser, filename, payload, prepare) {
  await seed(payload);
  const { context, page } = await pageFor(browser);
  try {
    await prepare(page);
    await screenshot(page, filename);
  } finally {
    await context.close();
  }
}

async function captureDragIntoFlow(browser) {
  await seed(payloads.drag);
  const { context, page } = await pageFor(browser);
  try {
    const source = page.locator('[data-testid="task-pool-card"]', {
      has: page.getByText("Drag this task into today", { exact: true }),
    });
    const target = page.getByTestId("day-flow-empty-state");
    await source.waitFor();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("Unable to resolve drag bounds");

    await page.mouse.move(sourceBox.x + 28, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceBox.x + 64, sourceBox.y + sourceBox.height / 2 + 8, {
      steps: 8,
    });
    await page.mouse.move(targetBox.x + targetBox.width * 0.38, targetBox.y + targetBox.height * 0.32, {
      steps: 18,
    });
    await screenshot(page, "flowday-drag.png");
    await page.mouse.up();
  } finally {
    await context.close();
  }
}

async function captureReorder(browser) {
  await seed(payloads.reorder);
  const { context, page } = await pageFor(browser);
  try {
    await flowCard(page, "reorder-c").waitFor();
    const sourceBox = await flowCard(page, "reorder-c").boundingBox();
    const targetBox = await flowCard(page, "reorder-a").boundingBox();
    if (!sourceBox || !targetBox) throw new Error("Unable to resolve reorder bounds");

    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height * 0.3, {
      steps: 18,
    });
    await screenshot(page, "flowday-reorder.png");
    await page.mouse.up();
  } finally {
    await context.close();
  }
}

async function capturePopOut(browser) {
  await seed(payloads.popout);
  const { context, page } = await pageFor(browser);
  try {
    await page.locator("text=Draft the launch update").first().waitFor();
    await flowCard(page, "pip-focus").locator('button[aria-label="Start timer"]').click();
    await page.waitForFunction(() => window.__FLOWDAY_E2E__?.getTimerState().status === "running");
    await page.evaluate(() => window.__FLOWDAY_E2E__.setRunningTimerElapsed(725));
    await page.evaluate(() => window.__FLOWDAY_E2E__.mountFakePopOutWindow());
    await page.getByTestId("fake-pop-out-root").waitFor();
    await page.addStyleTag({
      content: `
        [data-testid="fake-pop-out-root"] {
          position: fixed;
          right: 32px;
          bottom: 96px;
          z-index: 9999;
          width: 330px;
          height: 190px;
          overflow: hidden;
          border: 1px solid hsl(240 5.9% 90%);
          border-radius: 14px;
          background: white;
          box-shadow: 0 18px 45px rgba(0, 0, 0, 0.18);
        }
        [data-testid="fake-pop-out-root"]::before {
          content: "Floating timer window";
          display: block;
          height: 26px;
          padding: 6px 10px 0;
          border-bottom: 1px solid hsl(240 5.9% 90%);
          color: hsl(240 3.8% 46.1%);
          font-size: 11px;
          font-weight: 600;
          letter-spacing: .02em;
        }
        [data-testid="fake-pop-out-root"] > div { height: calc(100% - 26px); }
      `,
    });
    await page.locator('[data-testid="fake-pop-out-root"] >> text=Draft the launch update').waitFor();
    await screenshot(page, "flowday-popout.png");
  } finally {
    await context.close();
  }
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
    await capture(browser, "flowday-main.png", payloads.main, async (page) => {
      await page.locator("text=Implement onboarding polish").first().waitFor();
    });
    await capture(browser, "flowday-planning.png", payloads.planning, async (page) => {
      await page.getByText("Start Your Day").waitFor();
      await page.locator("text=Review roadmap").first().waitFor();
    });
    await captureDragIntoFlow(browser);
    await captureReorder(browser);
    await capture(browser, "flowday-timer.png", payloads.timer, async (page) => {
      await page.locator("text=Deep work on feature branch").first().waitFor();
      await flowCard(page, "timer-focus").locator('button[aria-label="Start timer"]').click();
      await page.waitForFunction(() => window.__FLOWDAY_E2E__?.getTimerState().status === "running");
      await page.evaluate(() => window.__FLOWDAY_E2E__.setRunningTimerElapsed(542));
      await page.locator("text=9:02").first().waitFor();
    });
    await capturePopOut(browser);
    await capture(browser, "flowday-multiday.png", payloads.multiday, async (page) => {
      await page.getByLabel("3-day view").click();
      await page.locator("text=Research queue cleanup").first().waitFor();
    });
    await capture(browser, "flowday-analytics.png", payloads.analytics, async (page) => {
      await page.getByLabel("Analytics").click();
      await page.getByRole("heading", { name: "Analytics" }).waitFor();
      await page.locator("text=Task Breakdown").first().waitFor();
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
  const readme = await readFile(path.join(docsRootDir, "README.md"), "utf8");
  const linkedImages = [...readme.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)].map((match) => match[1]);

  for (const image of expectedImages) {
    const relPath = `docs/readme/${image}`;
    if (!linkedImages.includes(relPath)) {
      throw new Error(`README.md does not reference ${relPath}`);
    }
  }

  for (const relPath of linkedImages) {
    const goldenPath = path.join(docsRootDir, relPath);
    const currentPath = path.join(outputDir, path.basename(relPath));
    await stat(goldenPath);
    await stat(currentPath);
    const buffer = await readFile(checkMode ? currentPath : goldenPath);
    const dimensions = readPngDimensions(buffer);
    if (dimensions.width !== 1440 || dimensions.height !== 960) {
      throw new Error(`${relPath} is ${dimensions.width}x${dimensions.height}, expected 1440x960`);
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
          `${relPath} does not match its generated golden: ${
            result.errorMessage
          } Inspect ${path.relative(
            rootDir,
            currentPath
          )}, then run npm run screenshots:readme if the UI change is intentional.`
        );
      }
    }

    log(`Verified ${relPath}`);
  }
}

async function main() {
  const server = await startApp();
  try {
    await waitForE2E(baseURL);
    await captureAll();
    await validateScreenshots();
    log(
      checkMode
        ? "README screenshots match committed goldens."
        : "README screenshots are up to date."
    );
  } finally {
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
