import { expect, test, type APIRequestContext } from "@playwright/test";

async function createResource(
  request: APIRequestContext,
  kind: string,
  fields: Record<string, unknown>,
) {
  const csrf = await request.get("/api/tasks/csrf");
  const { token } = await csrf.json();
  const result = await request.post(
    `/api/tasks/v1/${kind}?request_id=${crypto.randomUUID()}`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: fields,
    },
  );
  expect(result.status()).toBe(200);
  return result.json();
}

test("named colors persist on projects, labels and filters and keep their visual identity", async ({
  page,
  request,
}) => {
  await page.goto("/#/catalog");
  const choices = [
    {
      kind: "project",
      title: "Synthetic blue studio",
      name: "Blue",
      color: "rgb(64, 115, 255)",
    },
    {
      kind: "label",
      title: "SyntheticRedLabel",
      name: "Red",
      color: "rgb(219, 64, 53)",
    },
    {
      kind: "filter",
      title: "Synthetic violet view",
      name: "Violet",
      color: "rgb(175, 56, 235)",
    },
  ];
  for (const choice of choices) {
    await page
      .getByRole("button", { name: `Add ${choice.kind}`, exact: true })
      .last()
      .click();
    const dialog = page.getByRole("dialog", {
      name: `Add ${choice.kind}`,
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "Name", exact: true })
      .fill(choice.title);
    if (choice.kind === "filter")
      await dialog
        .getByRole("textbox", { name: "Query", exact: true })
        .fill("p1");
    await dialog.getByRole("combobox", { name: "Color", exact: true }).click();
    const colors = page.getByRole("listbox", { name: "Colors", exact: true });
    await expect(colors.getByRole("option")).toHaveCount(20);
    await colors
      .getByRole("option", { name: choice.name, exact: true })
      .click();
    await expect(
      dialog.getByRole("combobox", { name: "Color", exact: true }),
    ).toContainText(choice.name);
    await dialog
      .getByRole("checkbox", { name: "Add to favorites", exact: true })
      .check();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  await page.reload();
  for (const choice of choices) {
    const favorite = page
      .locator(".sidebar")
      .getByRole("link", { name: choice.title, exact: true });
    await expect(favorite.locator("svg").first()).toHaveCSS(
      "color",
      choice.color,
    );
    if (choice.kind !== "project") {
      const catalogLink = page
        .locator(".catalog-row")
        .filter({ hasText: choice.title })
        .getByRole("link");
      await expect(catalogLink.locator("svg").first()).toHaveCSS(
        "color",
        choice.color,
      );
    }
  }
  const catalogResponse = await request.get("/api/tasks/v1/catalog");
  const catalog = await catalogResponse.json();
  const label = catalog.labels.find(
    (item: { title: string }) => item.title === "SyntheticRedLabel",
  );
  const task = await createResource(request, "tasks", {
    title: "Synthetic colored task",
    label_ids: [label.id],
  });
  await page.goto("/#/inbox");
  const row = page
    .locator(".task-row")
    .filter({ has: page.getByText("Synthetic colored task", { exact: true }) });
  await expect(row.locator(".task-meta .lucide-tag")).toHaveCSS(
    "color",
    "rgb(219, 64, 53)",
  );
  await page.goto(`/?task=${task.id}#/inbox`);
  const details = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await expect(details.locator(".selected-label .lucide-tag")).toHaveCSS(
    "color",
    "rgb(219, 64, 53)",
  );
});

test("an existing custom color stays available without opening the operating system color wheel", async ({
  page,
  request,
}) => {
  const label = await createResource(request, "labels", {
    title: "Synthetic custom color",
    color: "#123456",
  });
  await page.goto("/#/catalog");
  await page
    .locator(".catalog-row")
    .filter({ hasText: "Synthetic custom color" })
    .getByRole("button", {
      name: "More actions for Synthetic custom color",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit label", exact: true });
  const color = dialog.getByRole("combobox", { name: "Color", exact: true });
  await expect(color).toContainText("Custom #123456");
  await expect(dialog.locator('input[type="color"]')).toHaveCount(0);
  await color.click();
  await expect(
    page.getByRole("option", { name: "Custom #123456", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole("listbox", { name: "Colors", exact: true }),
  ).not.toBeVisible();
  await color.click();
  await expect(
    page.getByRole("listbox", { name: "Colors", exact: true }),
  ).toBeVisible();
  await dialog.locator(".dialog-header").click({ position: { x: 8, y: 8 } });
  await expect(
    page.getByRole("listbox", { name: "Colors", exact: true }),
  ).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const response = await request.get("/api/tasks/v1/catalog");
  const catalog = await response.json();
  expect(
    catalog.labels.find((item: { id: string }) => item.id === label.id).color,
  ).toBe("#123456");
});

test("subtasks complete and reopen inside their parent editor, with dates and a named parent breadcrumb", async ({
  page,
  request,
}) => {
  const parent = await createResource(request, "tasks", {
    title: "Synthetic parent for inline work",
  });
  const child = await createResource(request, "tasks", {
    title: "Synthetic dated priority step",
    parent_id: parent.id,
    due_date: "2043-05-12",
    priority: 2,
  });
  await page.goto(`/?task=${parent.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  const childRow = dialog
    .getByRole("region", { name: "Subtasks", exact: true })
    .locator(".task-child-row");
  await expect(childRow.locator(".task-child-meta")).toContainText("May 12");
  await expect(
    childRow.getByRole("button", {
      name: "Complete Synthetic dated priority step",
      exact: true,
    }),
  ).toHaveClass(/priority-2/);
  await childRow
    .getByRole("button", {
      name: "Complete Synthetic dated priority step",
      exact: true,
    })
    .click();
  await expect(dialog).toBeVisible();
  await expect(childRow).toHaveClass(/is-completed/);
  await expect(dialog.getByRole("heading", { name: /Subtasks/ })).toContainText(
    "1/1",
  );
  await childRow
    .getByRole("button", {
      name: "Reopen Synthetic dated priority step",
      exact: true,
    })
    .click();
  await expect(childRow).not.toHaveClass(/is-completed/);
  await expect(dialog.getByRole("heading", { name: /Subtasks/ })).toContainText(
    "0/1",
  );
  await childRow
    .getByRole("button", { name: "Synthetic dated priority step", exact: true })
    .click();
  const parentLink = dialog.getByRole("button", {
    name: "Open parent task",
    exact: true,
  });
  await expect(parentLink).toHaveText(/Synthetic parent for inline work/);
  await parentLink.click();
  await expect(
    dialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toHaveValue("Synthetic parent for inline work");
  const response = await request.get(`/api/tasks/v1/tasks/${child.id}`);
  expect((await response.json()).completed ?? false).toBe(false);
});

test("the color menu uses its full native height when the viewport has room", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1360, height: 874 });
  await page.goto("/#/catalog");
  await page
    .getByRole("button", { name: "Add project", exact: true })
    .last()
    .click();
  const dialog = page.getByRole("dialog", { name: "Add project", exact: true });
  await dialog.getByRole("combobox", { name: "Color", exact: true }).click();
  const menu = page.getByRole("listbox", { name: "Colors", exact: true });
  const bounds = (await menu.boundingBox())!;
  expect(bounds.height).toBeGreaterThanOrEqual(270);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(874);
  await menu.getByRole("option", { name: "Charcoal", exact: true }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Color", exact: true }),
  ).toContainText("Charcoal");
  await expect(dialog).toBeVisible();
});
