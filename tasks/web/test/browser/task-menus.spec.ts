import { expect, test, type APIRequestContext } from "@playwright/test";

test.use({ serviceWorkers: "block", timezoneId: "UTC" });

async function createResource(
  request: APIRequestContext,
  kind: string,
  fields: Record<string, unknown>,
) {
  const csrf = await request.get("/api/tasks/csrf");
  const { token } = await csrf.json();
  const response = await request.post(
    `/api/tasks/v1/${kind}?request_id=${crypto.randomUUID()}`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: fields,
    },
  );
  expect(response.status()).toBe(200);
  return response.json();
}

test("right click and More share actions and contextual dates stay at the clicked row position", async ({
  page,
  request,
}) => {
  const task = await createResource(request, "tasks", {
    title: "Synthetic contextual dated task",
    due_date: "2044-04-04",
    due_datetime: "2044-04-04T21:15:00.000Z",
    due_timezone: "America/Los_Angeles",
    recurrence: "every week",
  });
  await page.clock.setFixedTime(new Date("2044-04-03T18:00:00Z"));
  await page.goto("/#/inbox");
  const row = page
    .locator(".task-row")
    .filter({ has: page.getByText(task.title, { exact: true }) });
  await row.scrollIntoViewIfNeeded();
  const bounds = await row.boundingBox();
  expect(bounds).not.toBeNull();
  const pointer = { x: bounds!.x + 40, y: bounds!.y + 15 };
  await page.mouse.click(pointer.x, pointer.y, { button: "right" });
  const menu = page.getByRole("menu", {
    name: `Actions for ${task.title}`,
    exact: true,
  });
  await expect(menu).toBeVisible();
  const labels = await menu
    .getByRole("menuitem")
    .evaluateAll((items) =>
      items.map(
        (item) => item.getAttribute("aria-label") || item.textContent?.trim(),
      ),
    );
  expect(labels).toEqual([
    "Today",
    "Tomorrow",
    "Next week",
    "Next weekend",
    "More dates",
    "Priority 1",
    "Priority 2",
    "Priority 3",
    "Priority 4",
    "Edit",
    "Go to project",
    "Deadline",
    "Complete",
    "Move to",
    "Duplicate",
    "Copy link to task",
    "Select task",
    "Delete",
  ]);
  const menuBounds = await menu.boundingBox();
  for (const label of labels.slice(0, 9)) {
    await menu.getByRole("menuitem", { name: label!, exact: true }).hover();
    await expect(page.getByRole("tooltip")).toHaveText(label!);
    expect(await menu.boundingBox()).toEqual(menuBounds);
  }
  await menu.getByRole("menuitem", { name: "More dates", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Date picker", exact: true });
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("textbox", { name: "Schedule", exact: true }),
  ).toBeFocused();
  expect(
    await page
      .getByRole("dialog", { name: "Task details", exact: true })
      .count(),
  ).toBe(0);
  const dateBounds = await picker.boundingBox();
  expect(Math.abs(dateBounds!.x - pointer.x)).toBeLessThan(40);
  await picker.locator('[data-date="2044-04-08"]').click();
  await expect(picker).not.toBeVisible();
  let result = await request.get(`/api/tasks/v1/tasks/${task.id}`);
  let saved = await result.json();
  expect(saved.due_date).toBe("2044-04-08");
  expect(saved.due_datetime.slice(11, 16)).toBe("21:15");
  expect(saved.due_timezone).toBe("America/Los_Angeles");
  expect(saved.recurrence).toBe("every week");
  await expect(row.locator(".task-meta")).toContainText("02:15 PM");
  await row
    .getByRole("button", {
      name: `More actions for ${task.title}`,
      exact: true,
    })
    .click();
  const moreMenu = page.getByRole("menu", {
    name: `More actions for ${task.title}`,
    exact: true,
  });
  await expect(moreMenu).toBeVisible();
  const moreLabels = await moreMenu
    .getByRole("menuitem")
    .evaluateAll((items) =>
      items.map(
        (item) => item.getAttribute("aria-label") || item.textContent?.trim(),
      ),
    );
  expect(moreLabels).toEqual(labels);
  await moreMenu
    .getByRole("menuitem", { name: "Priority 2", exact: true })
    .hover();
  await expect(page.getByRole("tooltip")).toHaveText("Priority 2");
  await moreMenu
    .getByRole("menuitem", { name: "Priority 2", exact: true })
    .click();
  await expect(
    row.getByRole("button", { name: `Complete ${task.title}`, exact: true }),
  ).toHaveClass(/priority-2/);
  await page.reload();
  result = await request.get(`/api/tasks/v1/tasks/${task.id}`);
  saved = await result.json();
  expect(saved.priority).toBe(2);
  await row
    .getByRole("button", {
      name: `More actions for ${task.title}`,
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Next weekend", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Task updated" }),
  ).toBeVisible();
  result = await request.get(`/api/tasks/v1/tasks/${task.id}`);
  saved = await result.json();
  expect(saved.due_date).toBe("2044-04-09");
  expect(saved.due_datetime.slice(11, 16)).toBe("21:15");
  expect(saved.recurrence).toBe("every week");
});

test("Duplicate copies full details and active subtasks once even when its response is lost", async ({
  page,
  request,
}) => {
  const description = "Synthetic full description beyond list preview. ".repeat(
    30,
  );
  const task = await createResource(request, "tasks", {
    title: "Synthetic menu duplicate",
    description,
  });
  const active = await createResource(request, "tasks", {
    title: "Synthetic duplicate active child",
    parent_id: task.id,
    description,
  });
  await createResource(request, "tasks", {
    title: "Synthetic duplicate active grandchild",
    parent_id: active.id,
  });
  const completed = await createResource(request, "tasks", {
    title: "Synthetic duplicate completed child",
    parent_id: task.id,
  });
  const csrf = await request.get("/api/tasks/csrf");
  const { token } = await csrf.json();
  const complete = await request.post(
    `/api/tasks/v1/tasks/${completed.id}:complete`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: { request_id: crypto.randomUUID(), etag: completed.etag },
    },
  );
  expect(complete.status()).toBe(200);
  await page.goto("/#/inbox");
  const row = page
    .locator(".task-row")
    .filter({ has: page.getByText(task.title, { exact: true }) })
    .first();
  let dropped = false;
  await page.route("**/api/tasks/v1/tasks/*:duplicate*", async (route) => {
    if (route.request().method() !== "POST" || dropped) return route.continue();
    dropped = true;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort("failed");
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await row
      .getByRole("button", {
        name: `More actions for ${task.title}`,
        exact: true,
      })
      .click();
    await page
      .getByRole("menuitem", { name: "Duplicate", exact: true })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: attempt ? "Task duplicated" : "Could not confirm" }),
    ).toBeVisible();
  }
  expect(dropped).toBe(true);
  const found = await request.get(
    `/api/tasks/v1/tasks?view=search&query=${encodeURIComponent(task.title)}`,
  );
  const records = (await found.json()).tasks.filter(
    (item: { title: string }) => item.title === task.title,
  );
  expect(records).toHaveLength(2);
  const copy = records.find((item: { id: string }) => item.id !== task.id);
  expect(records[0].id).toBe(task.id);
  expect(records[1].id).toBe(copy.id);
  const full = await request.get(`/api/tasks/v1/tasks/${copy.id}`);
  expect((await full.json()).description).toBe(description);
  const childrenResponse = await request.get(
    `/api/tasks/v1/tasks?parent_id=${copy.id}&include_completed=true`,
  );
  const children = (await childrenResponse.json()).tasks;
  expect(children.map((item: { title: string }) => item.title)).toEqual([
    "Synthetic duplicate active child",
  ]);
  expect(children[0].id).not.toBe(active.id);
  const childDetails = await request.get(
    `/api/tasks/v1/tasks/${children[0].id}`,
  );
  expect((await childDetails.json()).description).toBe(description);
  const grandchildrenResponse = await request.get(
    `/api/tasks/v1/tasks?parent_id=${children[0].id}&include_completed=true`,
  );
  expect(
    (await grandchildrenResponse.json()).tasks.map(
      (item: { title: string }) => item.title,
    ),
  ).toEqual(["Synthetic duplicate active grandchild"]);
});

test("sidebar and catalog menus save favorite and archive changes without deleting project data", async ({
  page,
  request,
}) => {
  const project = await createResource(request, "projects", {
    title: "Synthetic menu project",
    color: "#4073ff",
  });
  const task = await createResource(request, "tasks", {
    title: "Synthetic archived project task",
    project_id: project.id,
  });
  await page.goto("/#/inbox");
  let row = page
    .locator(".sidebar-context-row")
    .filter({
      has: page.getByRole("link", { name: project.title, exact: true }),
    })
    .first();
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Add to favorites", exact: true })
    .click();
  const favorites = page.locator(".sidebar-section").filter({
    has: page.getByRole("heading", { name: "Favorites", exact: true }),
  });
  await expect(
    favorites.getByRole("link", { name: project.title, exact: true }),
  ).toBeVisible();
  row = favorites.locator(".sidebar-context-row").filter({
    has: page.getByRole("link", { name: project.title, exact: true }),
  });
  await row
    .getByRole("button", {
      name: `More actions for ${project.title}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(
    page
      .locator(".sidebar")
      .getByRole("link", { name: project.title, exact: true }),
  ).toHaveCount(0);
  await page.goto("/#/inbox");
  await page
    .getByRole("button", { name: "Archived projects", exact: true })
    .click();
  const archived = page.locator(".sidebar-context-row").filter({
    has: page.getByRole("link", { name: project.title, exact: true }),
  });
  await archived
    .getByRole("button", {
      name: `More actions for ${project.title}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Unarchive", exact: true }).click();
  await page
    .getByRole("button", { name: "Show active projects", exact: true })
    .click();
  await expect(
    page
      .locator(".sidebar")
      .getByRole("link", { name: project.title, exact: true }),
  ).toHaveCount(2);
  const response = await request.get(`/api/tasks/v1/tasks/${task.id}`);
  expect(response.status()).toBe(200);
  expect((await response.json()).project_id).toBe(project.id);
});

test("contextual deadline and move choosers persist narrow changes without opening the full editor", async ({
  page,
  request,
}) => {
  const project = await createResource(request, "projects", {
    title: "Synthetic menu move destination",
    color: "#158fad",
  });
  const parent = await createResource(request, "tasks", {
    title: "Synthetic parent to move from menu",
    due_date: "2045-03-04",
  });
  const child = await createResource(request, "tasks", {
    title: "Synthetic step moves with parent",
    parent_id: parent.id,
  });
  await page.goto("/#/inbox");
  const row = page
    .locator(".task-row")
    .filter({ has: page.getByText(parent.title, { exact: true }) });
  await row
    .getByRole("button", {
      name: `More actions for ${parent.title}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Deadline", exact: true }).click();
  const deadline = page.getByRole("dialog", {
    name: "Deadline picker",
    exact: true,
  });
  await expect(deadline).toBeVisible();
  await deadline
    .getByRole("textbox", { name: "Deadline text", exact: true })
    .fill("2045-12-31");
  await deadline.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(deadline).not.toBeVisible();
  let saved = await (
    await request.get(`/api/tasks/v1/tasks/${parent.id}`)
  ).json();
  expect(saved.deadline).toBe("2045-12-31");
  expect(saved.due_date).toBe("2045-03-04");
  await row
    .getByRole("button", {
      name: `More actions for ${parent.title}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Move to", exact: true }).click();
  const search = page.getByRole("combobox", {
    name: "Search projects and sections",
    exact: true,
  });
  await expect(search).toBeFocused();
  await search.fill(project.title);
  await page.getByRole("option", { name: project.title, exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Task details", exact: true }),
  ).toHaveCount(0);
  saved = await (await request.get(`/api/tasks/v1/tasks/${parent.id}`)).json();
  expect(saved.project_id).toBe(project.id);
  expect(saved.deadline).toBe("2045-12-31");
  const savedChild = await (
    await request.get(`/api/tasks/v1/tasks/${child.id}`)
  ).json();
  expect(savedChild.project_id).toBe(project.id);
  expect(savedChild.parent_id).toBe(parent.id);
});
