import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { stubPlanning } from "./planning-stub";

async function width(page: Page) {
  return (await page.locator(".sidebar").boundingBox())!.width;
}
async function drag(page: Page, by: number) {
  const handle = page.getByRole("separator", { name: "Resize navigation" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, 120);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + by, 120, { steps: 6 });
  await page.mouse.up();
}

test("navigation drag and keyboard width persist after reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/inbox");
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  const initial = await width(page);
  await drag(page, 80);
  await expect.poll(() => width(page)).toBe(initial + 80);
  await page.reload();
  await expect.poll(() => width(page)).toBe(initial + 80);
  const handle = page.getByRole("separator", { name: "Resize navigation" });
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => width(page)).toBe(initial + 70);
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => width(page)).toBe(initial + 71);
  await page.reload();
  await expect.poll(() => width(page)).toBe(initial + 71);
});

test("navigation width stays bounded and a narrow window keeps the existing drawer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/inbox");
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  await drag(page, 600);
  await expect.poll(() => width(page)).toBe(360);
  await drag(page, -300);
  await expect.poll(() => width(page)).toBe(200);
  await page.setViewportSize({ width: 680, height: 850 });
  await expect(
    page.getByRole("separator", { name: "Resize navigation" }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect
    .poll(async () => (await page.locator(".sidebar").boundingBox())!.x)
    .toBe(0);
  await expect.poll(() => width(page)).toBe(245);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Close navigation" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByRole("separator", { name: "Resize navigation" }),
  ).toBeVisible();
  await expect.poll(() => width(page)).toBe(200);
});

test("Plan Review and Week fit the window after navigation resizing", async ({
  page,
}) => {
  await stubPlanning(page, {
    tasks: [
      {
        id: "layout-commit",
        title: "Synthetic committed outcome",
        stage: "committed",
        area: "work",
      },
      {
        id: "layout-step",
        kind: "step",
        parent_id: "layout-commit",
        title: "Synthetic executable next step",
        area: "work",
        duration_minutes: 45,
      },
      {
        id: "layout-quarter",
        title: "Synthetic quarterly outcome",
        stage: "quarterly",
        area: "personal",
      },
      {
        id: "layout-month",
        title: "Synthetic monthly outcome",
        stage: "monthly",
        area: "work",
      },
      {
        id: "layout-week",
        title: "Synthetic weekly candidate",
        stage: "weekly",
        area: "personal",
      },
    ],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/plan");
  await expect(
    page.getByText("Synthetic committed outcome", { exact: true }).first(),
  ).toBeVisible();
  await drag(page, 90);
  for (const size of [360, 768, 1024, 1440]) {
    await page.setViewportSize({ width: size, height: 900 });
    for (const tab of ["Review", "Week"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await expect(
        page.getByText("Synthetic committed outcome", { exact: true }).first(),
      ).toBeVisible();
      const overflow = await page.locator(".planning-ui").evaluate((root) => {
        return [
          root,
          ...root.querySelectorAll<HTMLElement>(
            ".plus-root-plan,.planning-view,.review-board,.planning-week,.planning-calendar,.planning-commitment-heading,.planning-commitment-heading>div,.planning-step-tray>header,.planning-calendar-heading,.planning-calendar-columns,.planning-compact-days",
          ),
        ]
          .filter(
            (element) =>
              element.clientWidth > 0 &&
              element.scrollWidth > element.clientWidth + 1,
          )
          .map((element) => ({
            className: element.className,
            available: element.clientWidth,
            contents: element.scrollWidth,
          }));
      });
      expect.soft(overflow, `${tab} at ${size}px`).toEqual([]);
      expect
        .soft(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          `${tab} at ${size}px`,
        )
        .toBe(true);
    }
  }
});

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

async function expectInsideWindow(page: Page, element: Locator) {
  const box = (await element.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  await expect
    .poll(() =>
      element.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return (
          [
            [rect.left + 3, rect.top + 3],
            [rect.right - 3, rect.top + 3],
            [rect.left + 3, rect.bottom - 3],
            [rect.right - 3, rect.bottom - 3],
          ] as const
        ).filter(([x, y]) => !node.contains(document.elementFromPoint(x, y)));
      }),
    )
    .toEqual([]);
}

test("task edits and property popups remain usable in narrow and short windows", async ({
  page,
  request,
}) => {
  const project = await createResource(request, "projects", {
    title: "Synthetic responsive destination",
  });
  for (const viewport of [
    { width: 360, height: 740 },
    { width: 1024, height: 620 },
  ]) {
    const task = await createResource(request, "tasks", {
      title: `Synthetic responsive task ${viewport.width}`,
      description: "Review the draft, choose its project and date, then save.",
    });
    await page.setViewportSize(viewport);
    await page.goto(`/?task=${task.id}#/inbox`);
    const dialog = page.getByRole("dialog", {
      name: "Task details",
      exact: true,
    });
    const title = dialog.getByRole("textbox", {
      name: "Task name",
      exact: true,
    });
    await expect(title).toHaveValue(task.title);
    await expectInsideWindow(page, title);
    await title.fill(`${task.title} edited`);

    await dialog
      .getByRole("combobox", { name: "Project", exact: true })
      .click();
    const projects = dialog.locator(".destination-popup");
    await expect(projects).toBeVisible();
    await expectInsideWindow(page, projects);
    await projects
      .getByRole("option", { name: project.title, exact: true })
      .click();
    await expect(projects).not.toBeVisible();
    await dialog.getByRole("button", { name: "Date", exact: true }).click();
    const dates = dialog.locator(".schedule-popup");
    await expect(dates).toBeVisible();
    await expectInsideWindow(page, dates);
    await dates.getByRole("button", { name: /^Tomorrow\b/ }).click();
    await expect(dates).not.toBeVisible();

    const save = dialog.getByRole("button", {
      name: "Save changes",
      exact: true,
    });
    await save.scrollIntoViewIfNeeded();
    await expectInsideWindow(page, save);
    await save.click();
    await expect(dialog).not.toBeVisible();
    const response = await request.get(`/api/tasks/v1/tasks/${task.id}`);
    const saved = await response.json();
    expect(saved.title).toBe(`${task.title} edited`);
    expect(saved.project_id).toBe(project.id);
    expect(saved.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }

  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/#/catalog");
  await page
    .getByRole("button", { name: "Add label", exact: true })
    .last()
    .click();
  const label = page.getByRole("dialog", { name: "Add label", exact: true });
  await label
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("SyntheticResponsiveLabel");
  await label.getByRole("combobox", { name: "Color", exact: true }).click();
  const colors = label.locator(".color-picker-popup");
  await expect(colors).toBeVisible();
  await expectInsideWindow(page, colors);
  await colors.getByRole("option", { name: "Blue", exact: true }).click();
  await label.getByRole("button", { name: "Save", exact: true }).click();
  await expect(label).not.toBeVisible();
  const catalog = await (await request.get("/api/tasks/v1/catalog")).json();
  expect(
    catalog.labels.find(
      (item: { title: string }) => item.title === "SyntheticResponsiveLabel",
    ).color,
  ).toBe("#4073ff");
});
