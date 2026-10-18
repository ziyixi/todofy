import { expect, test, type APIRequestContext } from "@playwright/test";

async function createTask(
  request: APIRequestContext,
  id: string,
  title: string,
) {
  const csrf = await (await request.get("/api/tasks/csrf")).json();
  const response = await request.post(
    `/api/tasks/v1/tasks?request_id=${id}&task_id=${id}`,
    {
      headers: { "x-csrf-token": csrf.token, origin: "http://127.0.0.1:8798" },
      data: { title },
    },
  );
  expect(response.status()).toBe(200);
  return response.json();
}

test("native mail creates no task until requested, replays a lost reply and deletes only mail", async ({
  page,
  request,
}) => {
  const linked = await createTask(
    request,
    crypto.randomUUID(),
    "Synthetic existing linked task",
  );
  const eventId = crypto.randomUUID();
  const oldEvent = crypto.randomUUID();
  const title = "Synthetic native mail without a task";
  let rows = [
    {
      id: eventId,
      title,
      etag: "mail-1",
      brief: "A synthetic decision to review.",
      has_summary: true,
      receive_time: "2026-10-17T12:30:00Z",
    },
    {
      id: oldEvent,
      title: "Synthetic mail with an existing task",
      etag: "mail-2",
      brief: "Keep the task when deleting this mail.",
      task: { provider: "tasks", external_id: linked.id },
    },
  ];
  const fileBodies: Record<string, unknown>[] = [];
  const forbidden: string[] = [];
  let delayRead = false;
  let finishRead: (() => void) | undefined;
  page.on("request", (sent) => {
    if (
      /\/api\/plus\/(?:flowday\/|v1\/(?:plan:read|tasks(?:\?|$)))/.test(
        sent.url(),
      )
    )
      forbidden.push(sent.url());
  });
  await page.route("**/api/plus/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/plus/v1/mailItems") {
      if (delayRead)
        await new Promise<void>((resolve) => {
          finishRead = resolve;
        });
      return route.fulfill({
        json: { mail_items: rows, categories: [], categories_etag: "cats-1" },
      });
    }
    if (path.endsWith(":readMailSummary"))
      return route.fulfill({
        json: {
          summary:
            "The full synthetic email summary.\nNo task has been created yet.",
        },
      });
    if (path.endsWith(":convertMailItem")) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      fileBodies.push(body);
      expect(body.event_id).toBe(eventId);
      const task = await createTask(request, String(body.request_id), title);
      if (fileBodies.length === 1) return route.abort("failed");
      rows = rows.filter((item) => item.id !== eventId);
      return route.fulfill({
        json: { task: { id: task.id, title: task.title } },
      });
    }
    if (path.endsWith(":deleteSummaries")) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(body.event_ids).toEqual([oldEvent]);
      expect(body.task_ids).toBeUndefined();
      rows = [];
      return route.fulfill({ json: { deleted_event_ids: [oldEvent] } });
    }
    return route.abort("blockedbyclient");
  });
  await page.goto("/#/mail");
  const first = page.locator(".native-mail-item").filter({ hasText: title });
  await expect(
    first.getByRole("button", { name: "Create task", exact: true }),
  ).toBeVisible();
  const absent = await (
    await request.get(
      `/api/tasks/v1/tasks?view=search&query=${encodeURIComponent(title)}`,
    )
  ).json();
  expect(absent.tasks ?? []).toEqual([]);
  await first
    .getByRole("button", { name: /^Synthetic native mail without a task/ })
    .click();
  await expect(first).toContainText("The full synthetic email summary.");
  delayRead = true;
  await page.getByRole("button", { name: "Refresh mail" }).click();
  await expect(first).toBeVisible();
  await expect.poll(() => Boolean(finishRead)).toBe(true);
  finishRead?.();
  delayRead = false;
  await expect(
    page.getByRole("button", { name: "Refresh mail" }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 360, height: 740 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await first.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await first.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(first).toHaveCount(0);
  expect(fileBodies).toHaveLength(2);
  expect(fileBodies[1]).toEqual(fileBodies[0]);
  const persisted = await (
    await request.get(
      `/api/tasks/v1/tasks?view=search&query=${encodeURIComponent(title)}`,
    )
  ).json();
  expect(persisted.tasks).toHaveLength(1);
  await page
    .getByRole("button", {
      name: "Delete mail Synthetic mail with an existing task",
      exact: true,
    })
    .click();
  const confirm = page.getByRole("dialog", {
    name: "Delete email?",
    exact: true,
  });
  await expect(confirm).toContainText("Existing tasks stay.");
  await confirm
    .getByRole("button", { name: "Delete mail", exact: true })
    .click();
  await expect(
    page.getByText("No mail to review", { exact: true }),
  ).toBeVisible();
  expect((await request.get(`/api/tasks/v1/tasks/${linked.id}`)).status()).toBe(
    200,
  );
  expect(forbidden).toEqual([]);
});

test("a definite mail conflict permits a fresh request after refresh", async ({
  page,
  request,
}) => {
  const csrf = await (await request.get("/api/tasks/csrf")).json();
  const labelResponse = await request.post(
    `/api/tasks/v1/labels?request_id=${crypto.randomUUID()}`,
    {
      headers: { "x-csrf-token": csrf.token, origin: "http://127.0.0.1:8798" },
      data: { title: "SyntheticMailShortcut" },
    },
  );
  const label = await labelResponse.json();
  const eventId = crypto.randomUUID();
  let etag = "old";
  let done = false;
  const bodies: Record<string, unknown>[] = [];
  let categories: {
    id: string;
    label: { provider: string; external_id: string };
    priority: string;
  }[] = [];
  await page.route("**/api/plus/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/plus/v1/mailItems")
      return route.fulfill({
        json: {
          mail_items: done
            ? []
            : [{ id: eventId, title: "Synthetic conflicting email", etag }],
          categories_etag: "1",
          categories,
        },
      });
    if (path.endsWith("mailSettings:read"))
      return route.fulfill({ json: { categories, etag: "1" } });
    if (path.endsWith("mailSettings:updateCategories")) {
      const body = route.request().postDataJSON();
      expect(body.destination).toBeUndefined();
      expect(body.categories[0]).toMatchObject({
        label: { provider: "tasks", external_id: label.id },
        priority: "p2",
      });
      categories = [{ id: "shortcut", ...body.categories[0] }];
      return route.fulfill({ json: { categories, etag: "2" } });
    }
    if (path.endsWith(":convertMailItem")) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        etag = "fresh";
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: 409,
              status: "ABORTED",
              message: "Mail changed. Refresh before trying again.",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "ETAG_MISMATCH",
                  domain: "todofy.ziyixi.science",
                },
              ],
            },
          },
        });
      }
      done = true;
      return route.fulfill({
        json: { task: { id: "synthetic-conflict-result" } },
      });
    }
    return route.abort("blockedbyclient");
  });
  await page.goto("/#/mail");
  await page
    .getByRole("button", { name: "Mail categories", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Mail categories",
    exact: true,
  });
  await settings
    .getByRole("button", { name: "Add a category", exact: true })
    .click();
  await settings
    .getByRole("combobox", { name: "Label 1", exact: true })
    .selectOption(label.id);
  await settings
    .getByRole("combobox", { name: "Priority 1", exact: true })
    .selectOption("2");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings).not.toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "SyntheticMailShortcut · P2",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Mail changed");
  await page.getByRole("button", { name: "Refresh mail" }).click();
  await expect(
    page.getByRole("button", { name: "Refresh mail" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByText("No mail to review", { exact: true }),
  ).toBeVisible();
  expect(bodies[0]?.etag).toBe("old");
  expect(bodies[1]?.etag).toBe("fresh");
  expect(bodies[0]?.request_id).not.toBe(bodies[1]?.request_id);
});

test("a filed email summary remains accessible by its link after leaving pending Mail", async ({
  page,
}) => {
  const id = crypto.randomUUID();
  const fullSummary =
    "Synthetic full detail.\n".repeat(900) +
    "This final paragraph was beyond the task copy.";
  await page.route("**/api/plus/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/plus/v1/mailItems")
      return route.fulfill({ json: { mail_items: [] } });
    if (url.pathname.endsWith(":readMailSummary")) {
      expect(url.searchParams.get("id")).toBe(id);
      return route.fulfill({
        json: {
          summary: fullSummary,
        },
      });
    }
    return route.abort("blockedbyclient");
  });
  await page.goto(`/?mail=${id}#/mail`);
  const summary = page.getByRole("dialog", {
    name: "Mail summary",
    exact: true,
  });
  await expect(summary).toContainText(
    "This final paragraph was beyond the task copy.",
  );
  await expect(page.locator(".native-mail-item")).toHaveCount(0);
  await summary.getByRole("button", { name: "Close", exact: true }).click();
  await expect(summary).not.toBeVisible();
  expect(new URL(page.url()).searchParams.has("mail")).toBe(false);
  expect(new URL(page.url()).hash).toBe("#/mail");
});
