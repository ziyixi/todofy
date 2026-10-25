import { expect, test, type Locator } from "@playwright/test";
import { seedGoalsPage } from "./goals-fixture";

test.use({ serviceWorkers: "block", viewport: { width: 1487, height: 1058 } });

async function editorGeometry(dialog: Locator) {
  return {
    dialog: await dialog.boundingBox(),
    title: await dialog
      .getByRole("textbox", { name: "Title", exact: true })
      .boundingBox(),
    kind: await dialog
      .getByRole("combobox", { name: "Kind", exact: true })
      .boundingBox(),
    footer: await dialog.locator(".goal-form-actions").boundingBox(),
    scroll: await dialog.evaluate((element) => element.scrollTop),
  };
}

test("native Goals saves definitions, current focus and evidence notes across reload, then deletes a note", async ({
  page,
  request,
}) => {
  const fixture = await seedGoalsPage(request);
  await page.goto(`/#/goals/${fixture.selected.id}`);
  await expect(
    page.getByRole("heading", { name: fixture.selected.title, exact: true }),
  ).toBeVisible();
  for (const objective of fixture.objectives)
    await expect(
      page.getByRole("tab", { name: objective.title, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByText("每周 4 小时练习", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Steps", exact: true }).click();
  await expect(page.locator(".goal-step")).toHaveCount(3);
  await expect(
    page.getByText("1 milestone confirmed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("示例实验的范围已确定，开始准备最小基线。", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/private/tmp/tasks-goals-ui-qa.png",
    fullPage: false,
  });

  await page
    .getByRole("button", { name: "Edit key result", exact: true })
    .click();
  const edit = page.getByRole("dialog", {
    name: "Edit key result",
    exact: true,
  });
  const revisedTitle = "Synthetic revised technical result";
  await edit
    .getByRole("textbox", { name: "Title", exact: true })
    .fill(revisedTitle);
  await edit
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Synthetic definition saved through the native editor.");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: revisedTitle, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Synthetic definition saved through the native editor.", {
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Adjust focus", exact: true }).click();
  const focus = page.getByRole("dialog", {
    name: "Adjust current focus",
    exact: true,
  });
  await focus
    .getByRole("textbox", { name: "Current focus", exact: true })
    .fill("Synthetic focus: publish a reproducible example");
  await focus.getByRole("button", { name: "Save", exact: true }).click();
  await expect(focus).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByText("Synthetic focus: publish a reproducible example", {
      exact: true,
    }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Record progress", exact: true })
    .click();
  const progress = page.getByRole("dialog", {
    name: "Record progress",
    exact: true,
  });
  const note =
    "Synthetic evidence: the baseline reproduces in a fresh environment.";
  await progress
    .getByRole("textbox", { name: "Progress note", exact: true })
    .fill(note);
  await progress
    .getByRole("textbox", { name: "Evidence link (optional)", exact: true })
    .fill("https://example.org/synthetic-proof");
  await progress
    .getByRole("button", { name: "Save progress", exact: true })
    .click();
  await expect(progress).toHaveCount(0);
  await page.reload();
  const entry = page
    .locator(".goal-progress-list > li")
    .filter({ hasText: note });
  await expect(entry).toBeVisible();
  await expect(
    entry.getByRole("link", { name: "View evidence", exact: true }),
  ).toHaveAttribute("href", "https://example.org/synthetic-proof");
  await entry.getByRole("button", { name: /^Delete progress from/u }).click();
  await page
    .getByRole("dialog", { name: "Delete progress note?", exact: true })
    .getByRole("button", { name: "Delete note", exact: true })
    .click();
  await expect(entry).toHaveCount(0);
  await page.reload();
  await expect(entry).toHaveCount(0);
  const notes = await (
    await request.get(
      `/api/tasks/v1/goalProgress?key_result_id=${fixture.selected.id}`,
    )
  ).json();
  expect(notes.goal_progress).toHaveLength(1);
});

test("completing linked Tasks and Steps persists without confirming the annual result or its milestones", async ({
  page,
  request,
}) => {
  const fixture = await seedGoalsPage(request);
  let goalWrites = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() !== "GET" &&
      /\/(keyResults|goalProgress)\//u.test(path)
    )
      goalWrites++;
  });
  await page.goto(`/#/goals/${fixture.selected.id}`);
  await page.getByRole("button", { name: "Steps", exact: true }).click();
  await page
    .getByRole("button", {
      name: `Complete ${fixture.steps[1]!.title}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: `Reopen ${fixture.steps[1]!.title}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: `Complete ${fixture.parent.title}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: `Reopen ${fixture.parent.title}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: `Reopen ${fixture.parent.title}`,
      exact: true,
    }),
  ).toBeVisible();
  const goal = await (
    await request.get(`/api/tasks/v1/keyResults/${fixture.selected.id}`)
  ).json();
  expect(goal.completed ?? false).toBe(false);
  expect(
    goal.milestones.map(
      (milestone: { completed?: boolean }) => milestone.completed ?? false,
    ),
  ).toEqual([true, false, false]);
  expect(goalWrites).toBe(0);
  const step = await (
    await request.get(`/api/tasks/v1/tasks/${fixture.steps[1]!.id}`)
  ).json();
  expect(step.completed).toBe(true);
  const notes = await (
    await request.get(
      `/api/tasks/v1/goalProgress?key_result_id=${fixture.selected.id}`,
    )
  ).json();
  expect(notes.goal_progress).toHaveLength(1);
  await expect(
    page.getByRole("checkbox", {
      name: "Result confirmed complete",
      exact: true,
    }),
  ).not.toBeChecked();
});

test("exploration has no metric prompts on a narrow screen and refresh preserves a focused editor draft and geometry", async ({
  page,
  request,
}) => {
  const fixture = await seedGoalsPage(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/goals/${fixture.exploration.id}`);
  await expect(
    page.getByRole("heading", { name: fixture.exploration.title, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Floor", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Ceiling", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Not set", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", {
      name: "Result confirmed complete",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks/v1/goalCatalog**", async (route) => {
    await held;
    await route.continue();
  });
  await page
    .getByRole("button", { name: "Refresh Goals", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit key result", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Edit key result",
    exact: true,
  });
  const title = dialog.getByRole("textbox", { name: "Title", exact: true });
  const draft = "Synthetic exploration draft held while refreshing";
  await title.fill(draft);
  await title.evaluate((input: HTMLInputElement) =>
    input.setSelectionRange(10, 15),
  );
  const before = await editorGeometry(dialog);
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/tasks/v1/goalCatalog",
  );
  release();
  await response;
  await expect(title).toHaveValue(draft);
  await expect(title).toBeFocused();
  expect(
    await title.evaluate((input: HTMLInputElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([10, 15]);
  expect(await editorGeometry(dialog)).toEqual(before);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("button", { name: "Edit key result", exact: true })
    .click();
  await expect(title).toHaveValue(fixture.exploration.title);
  expect(await editorGeometry(dialog)).toEqual(before);
});
