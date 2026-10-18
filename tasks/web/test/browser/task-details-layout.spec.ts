import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 1200 } });

async function createResource(
  request: APIRequestContext,
  kind: string,
  fields: Record<string, unknown>,
) {
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  const response = await request.post(
    `/api/tasks/v1/${kind}?request_id=${crypto.randomUUID()}`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: fields,
    },
  );
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<{ id: string; title: string }>;
}
async function mockPlan(
  page: Page,
  waitForPlanning: Promise<void> = Promise.resolve(),
) {
  await page.route("**/api/plus/v1/plan:read", (route) =>
    route.fulfill({
      json: { plan: { native_planning: true, dependencies: [] } },
    }),
  );
  await page.route("**/api/plus/v1/tasks?**", async (route) => {
    await waitForPlanning;
    const id = new URL(route.request().url()).searchParams.get("task_ids");
    await route.fulfill({
      json: {
        planning_tasks: [
          {
            id,
            etag: "synthetic-layout",
            explicit_stage: "committed",
            area: "work",
            lead_days: 14,
            planning_flags: ["task", "quick", "waiting", "routine"],
          },
        ],
      },
    });
  });
}

test("details show no guessed planning flags and keep their frame fixed as planning and children arrive", async ({
  page,
  request,
}, testInfo) => {
  const parent = await createResource(request, "tasks", {
    title: `Synthetic stable details ${crypto.randomUUID()}`,
    deadline: "2030-02-28",
  });
  for (let index = 0; index < 12; index++)
    await createResource(request, "tasks", {
      title: `Synthetic child ${String(index)}`,
      parent_id: parent.id,
      kind: index % 3 === 0 ? "step" : "task",
      due_date: "2030-01-03",
    });
  let releasePlanning!: () => void;
  let releaseChildren!: () => void;
  const planningReady = new Promise<void>((resolve) => {
    releasePlanning = resolve;
  });
  const childrenReady = new Promise<void>((resolve) => {
    releaseChildren = resolve;
  });
  await mockPlan(page, planningReady);
  await page.route("**/api/tasks/v1/tasks?**", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("parent_id") === parent.id
    )
      await childrenReady;
    await route.continue();
  });
  await page.goto(`/?task=${parent.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const before = await dialog.boundingBox();
  const planningBefore = await dialog
    .getByRole("region", { name: "Task planning", exact: true })
    .boundingBox();
  const guessedFlags = await dialog
    .getByRole("checkbox", { name: "Standalone action", exact: true })
    .count();
  await page.screenshot({
    path: testInfo.outputPath("tasks-details-loading-before.png"),
  });
  releasePlanning();
  await expect(
    dialog.getByRole("checkbox", { name: "Standalone action", exact: true }),
  ).toBeChecked();
  const afterPlanning = await dialog.boundingBox();
  const planningAfter = await dialog
    .getByRole("region", { name: "Task planning", exact: true })
    .boundingBox();
  releaseChildren();
  await expect(
    dialog.getByRole("button", { name: "Synthetic child 11", exact: true }),
  ).toBeVisible();
  const afterChildren = await dialog.boundingBox();
  await page.screenshot({
    path: testInfo.outputPath("tasks-details-loading-after.png"),
  });
  console.log(
    JSON.stringify({
      event: "task_detail_geometry",
      guessed_flags: guessedFlags,
      before,
      after_planning: afterPlanning,
      after_children: afterChildren,
    }),
  );
  expect(guessedFlags).toBe(0);
  expect(afterPlanning?.height).toBe(before?.height);
  expect(planningAfter?.height).toBe(planningBefore?.height);
  expect(afterChildren?.height).toBe(before?.height);
  expect(afterChildren?.y).toBe(before?.y);
  const action = dialog.getByRole("group", { name: "Action", exact: true });
  const status = dialog.getByRole("group", { name: "Status", exact: true });
  await expect(action.getByRole("checkbox")).toHaveCount(3);
  await expect(status.getByRole("checkbox")).toHaveCount(4);
});

test("reopening a cached task keeps the dependency heading and empty section still while checking fresh edges", async ({
  page,
  request,
}) => {
  const title = `Synthetic warm dependency layout ${crypto.randomUUID()}`;
  const parent = await createResource(request, "tasks", { title });
  await mockPlan(page);
  let reads = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let childReads = 0;
  let releaseChildren!: () => void;
  const childrenPending = new Promise<void>((resolve) => {
    releaseChildren = resolve;
  });
  await page.route("**/api/tasks/v1/tasks?**", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("parent_id") ===
        parent.id &&
      ++childReads === 2
    )
      await childrenPending;
    await route.continue();
  });
  await page.route("**/api/plus/v1/plan:read", async (route) => {
    if (++reads === 2) await pending;
    await route.fulfill({
      json: { plan: { native_planning: true, dependencies: [] } },
    });
  });
  await page.goto("/#/inbox");
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  const dependencies = dialog.getByRole("region", {
    name: "Task dependencies",
    exact: true,
  });
  const children = dialog.getByRole("region", {
    name: "Subtasks and steps",
    exact: true,
  });
  const open = () => page.getByText(title, { exact: true }).click();
  await open();
  await expect(
    dependencies.getByRole("button", { name: "Add dependency", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("combobox", { name: "Planning stage", exact: true }),
  ).toBeVisible();
  await expect(children.getByRole("status")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await open();
  await expect(dependencies.getByRole("status")).toBeVisible();
  await expect(children.getByRole("status")).toHaveCount(1);
  const before = {
    heading: await dependencies.locator("h3").boundingBox(),
    section: await dependencies.boundingBox(),
  };
  releaseChildren();
  await expect(children.getByRole("status")).toHaveCount(0);
  const afterChildren = {
    heading: await dependencies.locator("h3").boundingBox(),
    section: await dependencies.boundingBox(),
  };
  release();
  await expect(dependencies.getByRole("status")).toHaveCount(0);
  const after = {
    heading: await dependencies.locator("h3").boundingBox(),
    section: await dependencies.boundingBox(),
  };
  console.log(
    JSON.stringify({
      event: "warm_dependency_geometry",
      before,
      afterChildren,
      after,
      reads,
      childReads,
    }),
  );
  expect(reads).toBe(2);
  expect(afterChildren.heading?.y).toBe(before.heading?.y);
  expect(after.heading?.y).toBe(before.heading?.y);
  expect(after.section?.height).toBe(before.section?.height);
});

test("label selection floats above details and quick add without expanding either form", async ({
  page,
  request,
}) => {
  const labels = [];
  const suffix = crypto.randomUUID();
  for (let index = 0; index < 10; index++)
    labels.push(
      await createResource(request, "labels", {
        title: `Synthetic label ${String(index)} ${suffix}`,
      }),
    );
  const task = await createResource(request, "tasks", {
    title: `Synthetic label details ${suffix}`,
  });
  await mockPlan(page);
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await expect(
    dialog.getByRole("checkbox", { name: "Standalone action", exact: true }),
  ).toBeVisible();
  const before = await dialog.boundingBox();
  const scrollBefore = await dialog
    .locator(".task-edit-body")
    .evaluate((element) => element.scrollHeight);
  await dialog.getByText("Add labels", { exact: true }).click();
  const search = page.getByRole("textbox", {
    name: "Search labels",
    exact: true,
  });
  await expect(search).toBeVisible();
  const after = await dialog.boundingBox();
  const scrollAfter = await dialog
    .locator(".task-edit-body")
    .evaluate((element) => element.scrollHeight);
  const inline = await search.evaluate((element) =>
    Boolean(element.closest(".task-edit-body")),
  );
  console.log(
    JSON.stringify({
      event: "task_label_geometry",
      before,
      after,
      scroll_before: scrollBefore,
      scroll_after: scrollAfter,
      inline,
    }),
  );
  expect(inline).toBe(false);
  expect(after).toEqual(before);
  expect(scrollAfter).toBe(scrollBefore);
  await page
    .getByRole("checkbox", { name: labels[0]!.title, exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: labels[1]!.title, exact: true })
    .check();
  await page.keyboard.press("Escape");
  await expect(search).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const saved = await (
    await request.get(`/api/tasks/v1/tasks/${task.id}`)
  ).json();
  expect(saved.label_ids).toEqual([labels[0]!.id, labels[1]!.id]);
  await page.keyboard.press("q");
  const add = page.getByRole("dialog", { name: "Add task", exact: true });
  await expect(add).toBeVisible();
  const addBefore = await add.boundingBox();
  expect(addBefore?.height).toBeLessThan(before?.height || 0);
  await add.getByText("Add labels", { exact: true }).click();
  await expect(search).toBeVisible();
  expect(await add.boundingBox()).toEqual(addBefore);
  await page
    .getByRole("checkbox", { name: labels[2]!.title, exact: true })
    .check();
  await add.getByRole("textbox", { name: "Task name", exact: true }).click();
  await expect(search).not.toBeVisible();
  await expect(add).toBeVisible();
  await add
    .getByRole("textbox", { name: "Task name", exact: true })
    .fill(`Synthetic quick labels ${suffix}`);
  await add.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(add).not.toBeVisible();
  const created = await (
    await request.get(
      `/api/tasks/v1/tasks?view=search&query=${encodeURIComponent(`Synthetic quick labels ${suffix}`)}`,
    )
  ).json();
  expect(created.tasks[0].label_ids).toEqual([labels[2]!.id]);
});

test("property popups keep both task editors still on first open and reopen", async ({
  page,
  request,
}) => {
  const title = `Synthetic property geometry ${crypto.randomUUID()}`;
  await createResource(request, "tasks", { title });
  await createResource(request, "labels", {
    title: "Synthetic geometry label",
  });
  await mockPlan(page);
  await page.goto("/#/inbox");
  await expect(page.locator(".category-count").first()).toBeVisible();
  for (const name of ["Task details", "Add task"]) {
    if (name === "Task details")
      await page.getByText(title, { exact: true }).click();
    else await page.keyboard.press("q");
    const dialog = page.getByRole("dialog", { name, exact: true });
    await expect(dialog).toBeVisible();
    if (name === "Task details") {
      await expect(
        dialog.getByRole("combobox", { name: "Planning stage", exact: true }),
      ).toBeVisible();
      await expect(
        dialog
          .getByRole("region", { name: "Subtasks and steps", exact: true })
          .getByRole("status"),
      ).toHaveCount(0);
      await expect(
        dialog
          .getByRole("region", { name: "Task dependencies", exact: true })
          .getByRole("status"),
      ).toHaveCount(0);
    }
    const before = await dialog.boundingBox();
    const contentBefore = await dialog.locator(".dialog-content").boundingBox();
    const bodyBefore = await dialog
      .locator(".task-edit-body")
      .evaluate((body) => ({
        height: body.clientHeight,
        scroll: body.scrollHeight,
        top: body.scrollTop,
      }));
    const fields = [
      { role: "combobox", name: "Project", popup: ".destination-popup" },
      { role: "combobox", name: "Priority", popup: ".priority-popup" },
      { role: "button", name: "Date", popup: '[aria-label="Date picker"]' },
      {
        role: "button",
        name: "Deadline",
        popup: '[aria-label="Deadline picker"]',
      },
      { role: "button", name: "Add labels", popup: ".label-picker-popup" },
    ] as const;
    for (const field of fields) {
      for (let opening = 0; opening < 2; opening++) {
        await dialog
          .getByRole(field.role, { name: field.name, exact: true })
          .click();
        const popup = dialog.locator(field.popup);
        await expect(popup).toBeVisible();
        const sizes = await popup.evaluate(async (element) => {
          const frames: string[] = [];
          for (let frame = 0; frame < 10; frame++) {
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
            frames.push(`${element.clientWidth}x${element.clientHeight}`);
          }
          return frames;
        });
        expect(
          new Set(sizes).size,
          `${name}: ${field.name} opening ${opening}`,
        ).toBe(1);
        expect(await dialog.boundingBox()).toEqual(before);
        expect(await dialog.locator(".dialog-content").boundingBox()).toEqual(
          contentBefore,
        );
        expect(
          await dialog.locator(".task-edit-body").evaluate((body) => ({
            height: body.clientHeight,
            scroll: body.scrollHeight,
            top: body.scrollTop,
          })),
        ).toEqual(bodyBefore);
        await popup.press("Escape");
        await expect(popup).not.toBeVisible();
        await expect(dialog).toBeVisible();
        expect(await dialog.boundingBox()).toEqual(before);
      }
    }
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
  }
});

test("quick add keeps its compact frame while the saved task's planning write is pending", async ({
  page,
}) => {
  let release!: () => void;
  let pending!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    pending = resolve;
  });
  await mockPlan(page);
  await page.route("**/api/plus/v1/tasks:setTaskPlan", async (route) => {
    pending();
    await hold;
    const input = route.request().postDataJSON() as { task_id: string };
    await route.fulfill({
      json: {
        task: {
          id: input.task_id,
          etag: "saved-layout",
          explicit_stage: "committed",
        },
      },
    });
  });
  await page.goto("/#/inbox");
  await page.getByRole("button", { name: "Add task Q", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add task", exact: true });
  await add
    .getByRole("textbox", { name: "Task name", exact: true })
    .fill(`Synthetic pending add ${crypto.randomUUID()}`);
  await add
    .getByRole("combobox", { name: "Planning stage", exact: true })
    .selectOption("committed");
  const before = await add.boundingBox();
  await add.getByRole("button", { name: "Add task", exact: true }).click();
  await requested;
  const after = await page.locator(".task-dialog").boundingBox();
  const quick = await page
    .locator(".task-dialog")
    .evaluate((element) => element.classList.contains("quick-add-dialog"));
  console.log(
    JSON.stringify({
      event: "quick_add_pending_geometry",
      before,
      after,
      quick,
    }),
  );
  release();
  await expect(page.locator(".task-dialog")).toHaveCount(0);
  expect(quick).toBe(true);
  expect(after).toEqual(before);
});

test("narrow task details keep grouped controls and floating labels within the viewport", async ({
  page,
  request,
}, testInfo) => {
  for (let index = 0; index < 5; index++)
    await createResource(request, "labels", {
      title: `Synthetic narrow label ${String(index)} ${crypto.randomUUID()}`,
    });
  await page.setViewportSize({ width: 600, height: 900 });
  const task = await createResource(request, "tasks", {
    title: `Synthetic narrow details ${crypto.randomUUID()}`,
  });
  await mockPlan(page);
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  const action = dialog.getByRole("group", { name: "Action", exact: true });
  const status = dialog.getByRole("group", { name: "Status", exact: true });
  await expect(
    action.getByRole("checkbox", { name: "Standalone action", exact: true }),
  ).toBeChecked();
  const a = await action.boundingBox();
  const s = await status.boundingBox();
  expect(s?.y).toBeGreaterThanOrEqual((a?.y || 0) + (a?.height || 0));
  for (const checkbox of await dialog
    .getByRole("region", { name: "Task planning", exact: true })
    .getByRole("checkbox")
    .all()) {
    const box = await checkbox.boundingBox();
    expect(box?.width).toBe(14);
    expect(box?.height).toBe(14);
  }
  const before = await dialog.boundingBox();
  await dialog.getByText("Add labels", { exact: true }).click();
  const popup = page.getByRole("dialog", { name: "Label picker", exact: true });
  await expect(popup).toBeVisible();
  const p = await popup.boundingBox();
  expect(p?.x).toBeGreaterThanOrEqual(0);
  expect((p?.x || 0) + (p?.width || 0)).toBeLessThanOrEqual(600);
  expect(await dialog.boundingBox()).toEqual(before);
  await page.screenshot({
    path: testInfo.outputPath("tasks-details-narrow-labels.png"),
  });
  await page.keyboard.press("Escape");
  await expect(popup).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 900, height: 420 });
  await dialog.getByText("Add labels", { exact: true }).click();
  await expect(popup).toBeVisible();
  const dimensions = await popup.evaluate((element) => ({
    height: element.clientHeight,
    content: element.scrollHeight,
  }));
  console.log(JSON.stringify({ event: "short_label_popup", ...dimensions }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.height + 1);
});
