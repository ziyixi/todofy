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
  const search = page.getByRole("textbox", { name: "Search tasks", exact: true });
  await search.fill(before);
  await expect(page.getByRole("button", { name: before, exact: true })).toBeVisible();

  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route("**/api/tasks/v1/tasks?*", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.searchParams.get("query") === after) {
      requested();
      await held;
    }
    await route.continue();
  });
  await search.fill(after);
  await started;
  try {
    await expect(page.getByRole("button", { name: before, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No matching tasks", exact: true })).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByRole("button", { name: after, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: before, exact: true })).toHaveCount(0);
});
