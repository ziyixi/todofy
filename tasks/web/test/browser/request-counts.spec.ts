import { expect, test, type Page } from "@playwright/test";
import {
  createTask,
  planReads,
  reachesTodofy,
  seedMail,
  stubPlanning,
} from "./planning-stub";

// How many requests an interaction sends. Each count waits until the page has been idle for 500ms.
test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });

async function settled(page: Page) {
  await page.waitForLoadState("networkidle");
}
/** Requests that reach Todofy, which neither a task list nor Plan sends outside the weekly review. */
function todofyRequests(page: Page) {
  const paths: string[] = [];
  page.on("request", (event) => {
    const url = new URL(event.url());
    if (reachesTodofy(url.pathname)) paths.push(url.pathname);
  });
  return paths;
}

test("completing a card in Plan reads Plan once, and moving between Plan and Focus reads nothing", async ({
  page,
}) => {
  const task = { id: "counted-outcome", title: "Synthetic counted outcome" };
  const state = await stubPlanning(page, {
    tasks: [{ ...task, stage: "committed", area: "work" }],
  });
  await page.clock.setFixedTime(new Date(`${state.today}T18:00:00Z`));
  await page.goto("/#/plan");
  const committed = page.getByRole("region", {
    name: "Committed",
    exact: true,
  });
  await expect(
    committed.locator(`[data-outcome-id="${task.id}"]`),
  ).toBeVisible();
  await settled(page);
  expect(planReads(state)).toBe(1);
  await page.getByRole("link", { name: "Focus", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Focus", level: 1 }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Plan", exact: true }).click();
  await expect(committed).toBeVisible();
  await settled(page);
  expect(planReads(state)).toBe(1);
  await committed
    .getByRole("button", {
      name: `Complete task: ${task.title}`,
      exact: true,
    })
    .click();
  await expect(committed.locator(`[data-outcome-id="${task.id}"]`)).toHaveCount(
    0,
  );
  await settled(page);
  // Plan reads its own write back; the host's refresh after a write is only for the writes made elsewhere.
  expect(planReads(state)).toBe(2);
  // Plan and Focus read Tasks only: Todofy answers just the weekly review, which stayed closed.
  expect(state.requests).toEqual([]);
});

test("opening a task reads it once, its children only when it has some, and nothing from Todofy", async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID();
  const single = await createTask(request, {
    title: `Synthetic childless ${suffix}`,
  });
  const parent = await createTask(request, {
    title: `Synthetic parent ${suffix}`,
  });
  await createTask(request, {
    title: `Synthetic child ${suffix}`,
    parent_id: parent.id,
  });
  const todofy = todofyRequests(page);
  const reads: string[] = [];
  page.on("request", (event) => {
    const url = new URL(event.url());
    const parentId = url.searchParams.get("parent_id");
    if (event.method() !== "GET") return;
    if (url.pathname.startsWith("/api/tasks/v1/tasks/"))
      reads.push(`get ${url.pathname.slice("/api/tasks/v1/tasks/".length)}`);
    else if (url.pathname === "/api/tasks/v1/tasks" && parentId)
      reads.push(`children ${parentId}`);
  });
  await page.goto("/#/inbox");
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await page.getByText(single.title, { exact: true }).click();
  await expect(dialog).toBeVisible();
  await settled(page);
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.getByText(parent.title, { exact: true }).click();
  await expect(
    dialog.getByRole("button", {
      name: `Synthetic child ${suffix}`,
      exact: true,
    }),
  ).toBeVisible();
  await settled(page);
  expect(reads).toEqual([
    `get ${single.id}`,
    `get ${parent.id}`,
    `children ${parent.id}`,
  ]);
  // The rows and the dialog read their planning facts from the task itself.
  expect(todofy).toEqual([]);
});

test("a dialog save writes once and reads the list and catalog once without a token roundtrip", async ({
  page,
  request,
}) => {
  const task = await createTask(request, {
    title: `Synthetic counted save ${crypto.randomUUID()}`,
  });
  const sent: string[] = [];
  page.on("request", (event) => {
    const { pathname } = new URL(event.url());
    if (pathname.startsWith("/api/tasks/"))
      sent.push(`${event.method()} ${pathname}`);
  });
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  const stage = dialog.getByRole("combobox", {
    name: "Planning stage",
    exact: true,
  });
  await expect(stage).toBeVisible();
  await settled(page);
  // Mutations send the fixed custom header directly, with no token request at load or save.
  expect(sent.filter((line) => line === "GET /api/tasks/csrf")).toHaveLength(0);
  sent.length = 0;
  await stage.selectOption("weekly");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await settled(page);
  expect(sent.sort()).toEqual([
    "GET /api/tasks/v1/catalog",
    "GET /api/tasks/v1/tasks",
    `PATCH /api/tasks/v1/tasks/${task.id}`,
  ]);
});

test("opening Mail reads the mail and the categories together, once each", async ({
  page,
}) => {
  await seedMail([
    { id: crypto.randomUUID(), title: "Synthetic counted mail" },
  ]);
  const paths: string[] = [];
  page.on("request", (event) => {
    const url = new URL(event.url());
    if (
      /^\/api\/(?:mail|tasks)\/v1\/(?:mailItems|mailCategories)/.test(
        url.pathname,
      )
    )
      paths.push(url.pathname);
  });
  await page.goto("/#/mail");
  await expect(
    page.getByText("Synthetic counted mail", { exact: true }),
  ).toBeVisible();
  await settled(page);
  expect(paths.sort()).toEqual([
    "/api/mail/v1/mailItems",
    "/api/tasks/v1/mailCategories",
  ]);
});
