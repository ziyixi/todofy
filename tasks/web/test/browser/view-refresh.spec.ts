import { expect, test, type APIRequestContext } from "@playwright/test";

test.use({ serviceWorkers: "block" });

async function createTask(request: APIRequestContext, title: string) {
  const csrf = await request.get("/api/tasks/csrf");
  const { token } = await csrf.json();
  const response = await request.post(
    `/api/tasks/v1/tasks?request_id=${crypto.randomUUID()}`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: { title },
    },
  );
  expect(response.status()).toBe(200);
}

test("search keeps its previous result while the next real result is pending", async ({
  page,
  request,
}) => {
  const prefix = crypto.randomUUID();
  const before = `Search before ${prefix}`;
  const after = `Search after ${prefix}`;
  await createTask(request, before);
  await createTask(request, after);
  await page.goto("/#/search");
  const search = page.getByRole("textbox", {
    name: "Search tasks",
    exact: true,
  });
  await search.fill(before);
  await expect(
    page.getByRole("button", { name: before, exact: true }),
  ).toBeVisible();

  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/api/tasks/v1/tasks?*", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === "GET" &&
      url.searchParams.get("query") === after
    ) {
      requested();
      await held;
    }
    await route.continue();
  });
  await search.fill(after);
  await started;
  try {
    await expect(
      page.getByRole("button", { name: before, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "No matching tasks", exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
  await expect(
    page.getByRole("button", { name: after, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: before, exact: true }),
  ).toHaveCount(0);
});

test("empty search stays quiet and category counts update after a task completes", async ({
  page,
  request,
}) => {
  const csrf = await request.get("/api/tasks/csrf");
  const { token } = await csrf.json();
  const headers = { "x-csrf-token": token, origin: "http://127.0.0.1:8798" };
  const title = `Synthetic count project ${crypto.randomUUID()}`;
  const response = await request.post(
    `/api/tasks/v1/projects?request_id=${crypto.randomUUID()}`,
    { headers, data: { title } },
  );
  const project = await response.json();
  const taskTitle = `Synthetic count task ${crypto.randomUUID()}`;
  const taskResponse = await request.post(
    `/api/tasks/v1/tasks?request_id=${crypto.randomUUID()}`,
    { headers, data: { title: taskTitle, project_id: project.id } },
  );
  expect(taskResponse.status()).toBe(200);
  const searchRequests: string[] = [];
  page.on("request", (pending) => {
    const url = new URL(pending.url());
    if (
      url.pathname === "/api/tasks/v1/tasks" &&
      url.searchParams.get("view") === "search"
    )
      searchRequests.push(url.searchParams.get("query") ?? "");
  });
  await page.goto("/#/search");
  await expect(
    page.getByRole("heading", { name: "Find a task", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(searchRequests).toEqual([]);
  const projectLink = page
    .locator(".sidebar")
    .getByRole("link", { name: title, exact: true });
  await expect(projectLink.locator(".category-count")).toHaveText("1");
  await projectLink.click();
  const row = page
    .locator(".task-row")
    .filter({
      has: page.getByRole("button", { name: taskTitle, exact: true }),
    });
  await row
    .getByRole("button", { name: `Complete ${taskTitle}`, exact: true })
    .click();
  await expect(projectLink.locator(".category-count")).toHaveCount(0);
  await page.getByRole("button", { name: "My projects", exact: true }).click();
  await expect(projectLink).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "My projects", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "My projects", exact: true }).click();
  await expect(projectLink).toBeVisible();
  await page
    .getByRole("link", { name: "Labels & filters", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Labels & filters", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toHaveCount(0);
});
