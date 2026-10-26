import { expect, test, type APIRequestContext } from "@playwright/test";

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
test("details show Execution immediately and keep their controls fixed as children arrive", async ({
  page,
  request,
}, testInfo) => {
  const parent = await createResource(request, "tasks", {
    title: `Synthetic stable details ${crypto.randomUUID()}`,
    deadline: "2030-02-28",
    stage: "committed",
    area: "work",
    lead_days: 14,
    planning_flags: ["task", "quick", "waiting", "routine"],
  });
  for (let index = 0; index < 12; index++)
    await createResource(request, "tasks", {
      title: `Synthetic child ${String(index)}`,
      parent_id: parent.id,
      kind: index % 3 === 0 ? "step" : "task",
      due_date: "2030-01-03",
    });
  let releaseChildren!: () => void;
  const childrenReady = new Promise<void>((resolve) => {
    releaseChildren = resolve;
  });
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
  // GetTask answered the planning facts: they show with the dialog, not later.
  const execution = dialog.getByRole("radiogroup", {
    name: "Execution",
    exact: true,
  });
  const routine = dialog.getByRole("switch", { name: "Routine", exact: true });
  await expect(
    execution.getByRole("radio", { name: "Quick", exact: true }),
  ).toBeChecked();
  await expect(routine).toBeChecked();
  await expect(
    dialog.getByRole("combobox", { name: "Planning stage", exact: true }),
  ).toHaveValue("committed");
  const before = await dialog.boundingBox();
  const executionBefore = await execution.boundingBox();
  const routineBefore = await routine.boundingBox();
  await page.screenshot({
    path: testInfo.outputPath("tasks-details-loading-before.png"),
  });
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
      before,
      after_children: afterChildren,
    }),
  );
  expect(afterChildren?.height).toBe(before?.height);
  expect(afterChildren?.y).toBe(before?.y);
  expect(await execution.boundingBox()).toEqual(executionBefore);
  expect(await routine.boundingBox()).toEqual(routineBefore);
  await expect(execution.getByRole("radio")).toHaveCount(3);
  await expect(execution.getByRole("radio", { checked: true })).toHaveCount(1);
  for (const name of ["In progress", "Waiting", "On hold", "Parked"])
    await expect(
      dialog.getByRole("checkbox", { name, exact: true }),
    ).toHaveCount(0);
});

test("reopening a task shows its dependencies with the dialog, with no check pending and no children read", async ({
  page,
  request,
}) => {
  const title = `Synthetic warm dependency layout ${crypto.randomUUID()}`;
  const prerequisite = await createResource(request, "tasks", {
    title: `Synthetic awaited ${crypto.randomUUID()}`,
  });
  const parent = await createResource(request, "tasks", { title });
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  const linked = await request.patch(
    `/api/tasks/v1/tasks/${parent.id}?etag=1&request_id=${crypto.randomUUID()}&update_mask=dependencies`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: { dependencies: [{ prerequisite_id: prerequisite.id }] },
    },
  );
  expect(linked.status(), await linked.text()).toBe(200);
  let reads = 0;
  let childReads = 0;
  await page.route("**/api/tasks/v1/tasks**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("parent_id") === parent.id) childReads++;
    if (url.pathname === `/api/tasks/v1/tasks/${parent.id}`) reads++;
    await route.continue();
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
  const open = () => page.getByText(title, { exact: true }).click();
  const geometry = async () => ({
    heading: await dependencies
      .getByRole("heading", { name: /^Depends on/u })
      .boundingBox(),
    reverseHeading: await dependencies
      .getByRole("heading", { name: "Dependents", exact: true })
      .boundingBox(),
    section: await dependencies.boundingBox(),
  });
  await open();
  await expect(
    dependencies.getByRole("button", { name: prerequisite.title, exact: true }),
  ).toBeVisible();
  const first = await geometry();
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await open();
  await expect(
    dependencies.getByRole("button", { name: prerequisite.title, exact: true }),
  ).toBeVisible();
  await expect(dependencies.getByRole("status")).toHaveCount(0);
  const again = await geometry();
  console.log(
    JSON.stringify({
      event: "warm_dependency_geometry",
      first,
      again,
      reads,
      childReads,
    }),
  );
  expect([reads, childReads]).toEqual([2, 0]);
  expect(again.heading?.y).toBe(first.heading?.y);
  expect(again.section?.height).toBe(first.section?.height);
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
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await expect(
    dialog.getByRole("radiogroup", { name: "Execution", exact: true }),
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

test("quick add keeps its compact frame while its one write, planning included, is pending", async ({
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
  const creates: unknown[] = [];
  await page.route("**/api/tasks/v1/tasks?**", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    creates.push(route.request().postDataJSON());
    pending();
    await hold;
    await route.continue();
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
  // The content and the stage are one CreateTask.
  expect(creates).toEqual([expect.objectContaining({ stage: "committed" })]);
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
  // Existing execution and manual status flags must fit the narrow editor.
  const task = await createResource(request, "tasks", {
    title: `Synthetic narrow details ${crypto.randomUUID()}`,
    stage: "committed",
    area: "work",
    planning_flags: ["task", "quick", "waiting", "routine"],
  });
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  const execution = dialog.getByRole("radiogroup", {
    name: "Execution",
    exact: true,
  });
  const routine = dialog.getByRole("switch", { name: "Routine", exact: true });
  await expect(
    execution.getByRole("radio", { name: "Quick", exact: true }),
  ).toBeChecked();
  await expect(execution.getByRole("radio", { checked: true })).toHaveCount(1);
  await expect(routine).toBeChecked();
  const group = (await execution.boundingBox())!;
  const toggle = (await routine.boundingBox())!;
  expect(group.x).toBeGreaterThanOrEqual(0);
  expect(group.x + group.width).toBeLessThanOrEqual(600);
  expect(toggle.x).toBeGreaterThanOrEqual(group.x + group.width);
  expect(toggle.x + toggle.width).toBeLessThanOrEqual(600);
  expect(toggle.width).toBeGreaterThanOrEqual(32);
  expect(toggle.height).toBeGreaterThanOrEqual(18);
  let previous:
    { x: number; y: number; width: number; height: number } | undefined;
  for (const name of ["Steps", "Standalone", "Quick"]) {
    const option = execution.getByRole("radio", { name, exact: true });
    const box = (await option.locator("..").boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(40);
    expect(box.height).toBeGreaterThanOrEqual(32);
    expect(box.x).toBeGreaterThanOrEqual(group.x);
    expect(box.x + box.width).toBeLessThanOrEqual(group.x + group.width + 1);
    if (previous) {
      expect(box.y).toBe(previous.y);
      expect(box.height).toBe(previous.height);
      expect(Math.abs(box.x - previous.x - previous.width)).toBeLessThanOrEqual(
        1,
      );
    }
    previous = box;
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
  await page.setViewportSize({ width: 360, height: 740 });
  for (const option of await dialog
    .locator(".task-execution-option > span")
    .all()) {
    const size = await option.evaluate((element) => ({
      available: element.clientWidth,
      text: element.scrollWidth,
    }));
    expect(size.text).toBeLessThanOrEqual(size.available + 1);
  }
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
