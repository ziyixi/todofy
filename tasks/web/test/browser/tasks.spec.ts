import { expect, test, type APIRequestContext } from "@playwright/test";

test("retrying Quick Add after a lost response keeps one persisted task", async ({
  page,
  request,
}) => {
  const title = "Synthetic retry keeps one task";
  await page.goto("/#/inbox");
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  let dropped = false;
  await page.route("**/api/tasks/v1/tasks?*", async (route) => {
    if (route.request().method() !== "POST" || dropped) return route.continue();
    dropped = true;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort("failed");
  });
  await page.keyboard.press("q");
  const dialog = page.getByRole("dialog", { name: "Add task" });
  await dialog
    .getByRole("textbox", { name: "Task name", exact: true })
    .fill(title);
  await dialog.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const result = await request.get(
    `/api/tasks/v1/tasks?view=search&query=${encodeURIComponent(title)}`,
  );
  expect(result.status()).toBe(200);
  const body = await result.json();
  expect(
    body.tasks.filter((task: { title: string }) => task.title === title),
  ).toHaveLength(1);
});

async function createTask(
  request: APIRequestContext,
  title: string,
  fields: Record<string, unknown> = {},
) {
  const csrf = await request.get("/api/tasks/csrf");
  const { token } = await csrf.json();
  const result = await request.post(
    `/api/tasks/v1/tasks?request_id=${crypto.randomUUID()}`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: { title, ...fields },
    },
  );
  expect(result.status()).toBe(200);
  return result.json();
}

test("quick add, edit, complete and reopen persist through page reload", async ({
  page,
}) => {
  await page.goto("/#/today");
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("q");
  const dialog = page.getByRole("dialog", { name: "Add task" });
  await expect(
    dialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toBeFocused();
  await page.keyboard.type("Synthetic task for the weekly review");
  await dialog
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Check the saved fields after a reload.");
  await dialog.getByRole("combobox", { name: "Priority", exact: true }).click();
  await dialog.getByRole("option", { name: "Priority 1", exact: true }).click();
  await dialog.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page
    .getByRole("button")
    .filter({ hasText: "Synthetic task for the weekly review" })
    .first()
    .click();
  const details = page.getByRole("dialog", { name: "Task details" });
  await expect(
    details.getByRole("combobox", { name: "Priority", exact: true }),
  ).toHaveText("Priority 1");
  await details
    .getByRole("textbox", { name: "Task name", exact: true })
    .fill("Synthetic edited review task");
  await details.getByRole("button", { name: "Save changes" }).click();
  await page
    .getByRole("button", {
      name: "Complete Synthetic edited review task",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Synthetic edited review task", { exact: true }),
  ).not.toBeVisible();
  await page
    .getByRole("link", { name: "Completed tasks", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Reopen Synthetic edited review task",
      exact: true,
    })
    .click();
  await page.getByRole("link", { name: "Inbox", exact: true }).click();
  await expect(
    page.getByText("Synthetic edited review task", { exact: true }),
  ).toBeVisible();
});

test("nested subtasks remain attached and natural-date preview keeps deadline independent", async ({
  page,
  request,
}) => {
  const parent = await createTask(request, "Synthetic parent commitment");
  await page.goto(`/?task=${parent.id}#/inbox`);
  const dialog = page.getByRole("dialog", { name: "Task details" });
  await dialog
    .getByRole("textbox", { name: "New subtask" })
    .fill("Synthetic step under two hours");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog
    .getByRole("button", {
      name: "Synthetic step under two hours",
      exact: true,
    })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Open parent task" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Date", exact: true }).click();
  await dialog.getByLabel("Schedule", { exact: true }).fill("every Tuesday");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText(/Next:/);
  await dialog.getByLabel("Time", { exact: true }).fill("14:15");
  await dialog.getByRole("button", { name: "Deadline", exact: true }).click();
  await dialog.getByLabel("Deadline text", { exact: true }).fill("2026-12-31");
  await dialog
    .getByRole("dialog", { name: "Deadline picker", exact: true })
    .getByRole("button", { name: "Apply", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Deadline", exact: true }),
  ).toHaveText("Dec 31");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await dialog
    .getByRole("button", {
      name: "Synthetic step under two hours",
      exact: true,
    })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Deadline", exact: true }),
  ).toHaveText("Dec 31");
  await dialog.getByRole("button", { name: "Date", exact: true }).click();
  await expect(dialog.getByLabel("Time", { exact: true })).toHaveValue("14:15");
  await expect(dialog.getByLabel("Repeat", { exact: true })).toHaveValue(
    /Tuesday/i,
  );
});

test("moving a timed date preserves the local clock time across daylight saving", async ({
  page,
  request,
}) => {
  const task = await createTask(request, "Synthetic timed date", {
    due_date: "2026-10-27",
    due_datetime: "2026-10-27T18:00:00Z",
    due_timezone: "America/Los_Angeles",
  });
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", { name: "Task details" });
  await dialog.getByRole("button", { name: "Date", exact: true }).click();
  await expect(dialog.getByLabel("Time", { exact: true })).toHaveValue("11:00");
  await dialog
    .getByRole("gridcell", { name: "Tuesday, November 3, 2026" })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Save changes" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).not.toBeVisible();
  const saved = await (await request.get(`/api/tasks/v1/${task.name}`)).json();
  expect(saved.due_date).toBe("2026-11-03");
  expect(saved.due_datetime).toBe("2026-11-03T19:00:00.000Z");
  expect(saved.due_timezone).toBe("America/Los_Angeles");
});

test("property menus search colored project sections, support keyboard choices and dismiss inside the task dialog", async ({
  page,
  request,
}) => {
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  const headers = { "x-csrf-token": token, origin: "http://127.0.0.1:8798" };
  const projectResponse = await request.post(
    `/api/tasks/v1/projects?request_id=${crypto.randomUUID()}`,
    {
      headers,
      data: { title: "Synthetic menu studio", color: "#db4035" },
    },
  );
  expect(projectResponse.status()).toBe(200);
  const project = await projectResponse.json();
  const sectionResponse = await request.post(
    `/api/tasks/v1/sections?request_id=${crypto.randomUUID()}`,
    {
      headers,
      data: { title: "Synthetic next steps", project_id: project.id },
    },
  );
  expect(sectionResponse.status()).toBe(200);
  const section = await sectionResponse.json();
  await page.goto("/#/inbox");
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("q");
  const dialog = page.getByRole("dialog", { name: "Add task", exact: true });
  await dialog
    .getByLabel("Task name", { exact: true })
    .fill("Synthetic selected properties");
  await dialog.getByRole("combobox", { name: "Project", exact: true }).click();
  const search = dialog.getByRole("combobox", {
    name: "Search projects and sections",
  });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await search.fill("next steps");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(
    dialog.getByRole("combobox", { name: "Project", exact: true }),
  ).toHaveText("Synthetic menu studio / Synthetic next steps");
  await dialog.getByRole("combobox", { name: "Priority", exact: true }).click();
  const redFlag = dialog
    .getByRole("option", { name: "Priority 1", exact: true })
    .locator("svg")
    .first();
  await expect(redFlag).toHaveAttribute("fill", "#d1453b");
  await dialog.getByRole("option", { name: "Priority 2", exact: true }).click();
  await dialog.getByRole("button", { name: "Date", exact: true }).click();
  await expect(
    dialog.getByRole("dialog", { name: "Date picker", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    dialog.getByRole("dialog", { name: "Date picker", exact: true }),
  ).not.toBeVisible();
  await dialog.getByRole("button", { name: "Deadline", exact: true }).click();
  await expect(
    dialog.getByRole("dialog", { name: "Date picker", exact: true }),
  ).not.toBeVisible();
  await expect(
    dialog.getByRole("dialog", { name: "Deadline picker", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    dialog.getByRole("dialog", { name: "Deadline picker", exact: true }),
  ).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Date", exact: true }).click();
  await dialog.getByText("Date", { exact: true }).click();
  await expect(
    dialog.getByRole("dialog", { name: "Date picker", exact: true }),
  ).not.toBeVisible();
  await dialog.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const response = await request.get(
    `/api/tasks/v1/tasks?view=search&query=${encodeURIComponent("Synthetic selected properties")}`,
  );
  const saved = (await response.json()).tasks.find(
    (task: { title: string }) => task.title === "Synthetic selected properties",
  );
  expect(saved.project_id).toBe(project.id);
  expect(saved.section_id).toBe(section.id);
  expect(saved.priority).toBe(2);
});

test("project and label edits appear in task picker and filter views", async ({
  page,
}) => {
  await page.goto("/#/catalog");
  await page
    .getByRole("button", { name: "Add project", exact: true })
    .last()
    .click();
  let dialog = page.getByRole("dialog", { name: "Add project" });
  await dialog
    .getByLabel("Name", { exact: true })
    .fill("Synthetic studio project");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Add label", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Add label" });
  await dialog.getByLabel("Name", { exact: true }).fill("SyntheticFocus");
  await dialog.getByLabel("Add to favorites").check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("link", { name: "Synthetic studio project", exact: true })
    .first()
    .click();
  await page.keyboard.press("q");
  dialog = page.getByRole("dialog", { name: "Add task" });
  await dialog
    .getByLabel("Task name", { exact: true })
    .fill("Synthetic labelled task");
  await dialog.getByText("Add labels", { exact: true }).click();
  await dialog.getByLabel("SyntheticFocus", { exact: true }).check();
  await dialog.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByRole("link", { name: "SyntheticFocus", exact: true }).click();
  await expect(
    page.getByText("Synthetic labelled task", { exact: true }),
  ).toBeVisible();
});

test("dense desktop layout and escape keep the page usable at 1024 pixels", async ({
  page,
  request,
}) => {
  await createTask(
    request,
    "Synthetic long title that stays readable on a compact desktop without pushing the controls off the screen",
  );
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto("/#/inbox");
  await expect(
    page.getByText(
      "Synthetic long title that stays readable on a compact desktop without pushing the controls off the screen",
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("q");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("dragging custom order persists and selected tasks complete as a group", async ({
  page,
  request,
}) => {
  await createTask(request, "Synthetic ordered Alpha");
  await createTask(request, "Synthetic ordered Beta");
  await page.goto("/#/inbox");
  const alpha = page.locator(".task-row").filter({
    has: page.getByText("Synthetic ordered Alpha", { exact: true }),
  });
  const beta = page
    .locator(".task-row")
    .filter({ has: page.getByText("Synthetic ordered Beta", { exact: true }) });
  await beta.hover();
  const persisted = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().includes("/api/tasks/v1/tasks/"),
  );
  await beta
    .getByRole("button", { name: "Drag Synthetic ordered Beta", exact: true })
    .dragTo(alpha);
  expect((await persisted).status()).toBe(200);
  await page.reload();
  await expect(
    page.getByText("Synthetic ordered Beta", { exact: true }),
  ).toBeVisible();
  const ordered = await page.locator(".task-title").allTextContents();
  expect(ordered.indexOf("Synthetic ordered Beta")).toBeLessThan(
    ordered.indexOf("Synthetic ordered Alpha"),
  );
  await alpha.hover();
  await page
    .getByRole("checkbox", {
      name: "Select Synthetic ordered Alpha",
      exact: true,
    })
    .check();
  await beta.hover();
  await page
    .getByRole("checkbox", {
      name: "Select Synthetic ordered Beta",
      exact: true,
    })
    .check();
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(
    page.getByText("Synthetic ordered Alpha", { exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByText("Synthetic ordered Beta", { exact: true }),
  ).not.toBeVisible();
});

test("completing a parent with a recurring subtask shows the reason inside its open editor", async ({
  page,
  request,
}) => {
  const parent = await createTask(
    request,
    "Synthetic parent with recurring work",
  );
  await createTask(request, "Synthetic daily recurring child", {
    parent_id: parent.id,
    due_date: "2030-01-01",
    recurrence: "every day",
  });
  await page.goto(`/?task=${parent.id}#/inbox`);
  const dialog = page.getByRole("dialog", { name: "Task details" });
  await expect(
    dialog.getByRole("button", {
      name: "Synthetic daily recurring child",
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Complete task", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Complete recurring subtasks separately before completing their parent",
  );
  await expect(dialog).toBeVisible();
  const saved = await request.get(`/api/tasks/v1/tasks/${parent.id}`);
  expect(saved.status()).toBe(200);
  expect((await saved.json()).completed ?? false).toBe(false);
});

test("task descriptions render Markdown, edit and persist without loading remote images", async ({
  page,
  request,
}) => {
  const parent = await createTask(request, "Synthetic formatted description", {
    description:
      "Read [the guide](https://example.org/guide). Plain source: https://example.org/source?id=123&view=full.\n\n- First step\n- Second step\n\n![Reference image](https://example.org/private-image.png)\n\n<script>window.descriptionUnsafe = true</script>",
  });
  const remoteRequests: string[] = [];
  page.on("request", (incoming) => {
    if (incoming.url().startsWith("https://example.org/"))
      remoteRequests.push(incoming.url());
  });
  await page.goto(`/?task=${parent.id}#/inbox`);
  const dialog = page.getByRole("dialog", { name: "Task details" });
  const description = dialog.getByRole("region", { name: "Task description" });
  const guide = description.getByRole("link", {
    name: "the guide",
    exact: true,
  });
  await expect(guide).toHaveAttribute("href", "https://example.org/guide");
  await expect(guide).toHaveAttribute("target", "_blank");
  const bareLink = description.getByRole("link", {
    name: "https://example.org/source?id=123&view=full",
    exact: true,
  });
  await expect(bareLink).toHaveAttribute(
    "href",
    "https://example.org/source?id=123&view=full",
  );
  await expect(bareLink).toHaveAttribute("target", "_blank");
  expect(remoteRequests).toEqual([]);
  await expect(description.getByRole("listitem")).toHaveCount(2);
  await expect(description.locator("img, script")).toHaveCount(0);
  await expect(description.getByRole("textbox")).toHaveCount(0);
  await description
    .getByRole("button", { name: "Edit description", exact: true })
    .click();
  const editor = description.getByRole("textbox", {
    name: "Description",
    exact: true,
  });
  await expect(editor).toHaveValue(/\[the guide\]/);
  await editor.fill(
    "Updated [the guide](https://example.org/updated).\n\n- Saved step",
  );
  await description.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    description.getByRole("link", { name: "the guide", exact: true }),
  ).toHaveAttribute("href", "https://example.org/updated");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.goto(`/?task=${parent.id}#/inbox`);
  await page.reload();
  await expect(
    description.getByRole("link", { name: "the guide", exact: true }),
  ).toHaveAttribute("href", "https://example.org/updated");
  await expect(description.getByRole("listitem")).toHaveText(["Saved step"]);
  expect(remoteRequests).toEqual([]);
});

test("Upcoming keeps dates chronological while preserving each day's custom task order", async ({
  page,
  request,
}) => {
  await createTask(request, "Synthetic later day first in custom order", {
    due_date: "2040-06-07",
    sort_order: 10,
  });
  await createTask(request, "Synthetic earlier day second task", {
    due_date: "2040-06-05",
    sort_order: 40,
  });
  await createTask(request, "Synthetic earlier day first task", {
    due_date: "2040-06-05",
    sort_order: 20,
  });
  await page.clock.setFixedTime(new Date("2040-06-04T12:00:00"));
  await page.goto("/#/upcoming");
  const headings = page.locator(".task-group-heading");
  await expect(headings).toHaveCount(2);
  await expect(headings.nth(0)).toContainText("Jun 5");
  await expect(headings.nth(1)).toContainText("Jun 7");
  const days = page.locator(".task-groups > section");
  await expect(days.nth(0).locator(".task-title")).toHaveText([
    "Synthetic earlier day first task",
    "Synthetic earlier day second task",
  ]);
  await expect(days.nth(1).locator(".task-title")).toHaveText([
    "Synthetic later day first in custom order",
  ]);
});

test.describe("account calendar", () => {
  test.use({ timezoneId: "UTC" });

  test("Today and new task dates follow the account calendar across UTC midnight", async ({
    page,
    request,
  }) => {
    await page.clock.setFixedTime(new Date("2026-10-18T01:00:00Z"));
    let releaseCatalog!: () => void;
    const catalogReady = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    await page.route("**/api/tasks/v1/catalog", async (route) => {
      await catalogReady;
      await route.continue();
    });
    await page.goto("/#/today");
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await page.keyboard.press("q");
    releaseCatalog();
    const dialog = page.getByRole("dialog", { name: "Add task", exact: true });
    await expect(dialog).toBeVisible();
    await expect(page.locator(".view-subtitle")).toHaveText("Saturday, October 17");
    await dialog
      .getByLabel("Task name", { exact: true })
      .fill("Synthetic account calendar task");
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/tasks/v1/tasks",
    );
    await dialog.getByRole("button", { name: "Add task", exact: true }).click();
    const task = await (await saved).json();
    expect(task.due_date).toBe("2026-10-17");
    const stored = await request.get(`/api/tasks/v1/${task.name}`);
    expect((await stored.json()).due_date).toBe("2026-10-17");
    const upcoming = page.waitForRequest((request) =>
      new URL(request.url()).searchParams.get("view") === "upcoming",
    );
    await page.getByRole("link", { name: "Upcoming", exact: true }).click();
    expect(new URL((await upcoming).url()).searchParams.get("date")).toBe(
      "2026-10-17",
    );
  });
});
