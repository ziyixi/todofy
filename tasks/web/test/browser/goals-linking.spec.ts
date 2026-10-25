import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
} from "@playwright/test";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 1100 } });

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
  return response.json() as Promise<{
    id: string;
    title: string;
    etag: string;
  }>;
}

async function seedGoal(request: APIRequestContext) {
  const catalog = await (await request.get("/api/tasks/v1/goalCatalog")).json();
  const objective = await createResource(request, "objectives", {
    title: `Synthetic linked objective ${crypto.randomUUID()}`,
    year: catalog.year,
  });
  return createResource(request, "keyResults", {
    title: `Synthetic linked result ${crypto.randomUUID()}`,
    objective_id: objective.id,
  });
}

async function geometry(dialog: Locator) {
  return {
    dialog: await dialog.boundingBox(),
    execution: await dialog
      .getByRole("radiogroup", { name: "Execution", exact: true })
      .boundingBox(),
    footer: await dialog.locator(".dialog-footer").boundingBox(),
    body: await dialog
      .locator(".task-edit-body")
      .evaluate((body) => ({ height: body.clientHeight, top: body.scrollTop })),
  };
}

test("loads only the small catalog on picker open and keeps asynchronous and cached geometry fixed", async ({
  page,
  request,
}) => {
  const goal = await seedGoal(request);
  const task = await createResource(request, "tasks", {
    title: `Synthetic lazy goal ${crypto.randomUUID()}`,
  });
  let reads = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks/v1/goalCatalog**", async (route) => {
    reads++;
    await hold;
    await route.continue();
  });
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const trigger = dialog.getByRole("button", {
    name: "Associated goal",
    exact: true,
  });
  const before = await geometry(dialog);
  expect(reads).toBe(0);
  await trigger.click();
  const popup = page.getByRole("dialog", { name: "Goal picker", exact: true });
  const search = popup.getByRole("textbox", {
    name: "Search goals",
    exact: true,
  });
  await expect(search).toBeFocused();
  await expect(popup.getByText("Loading goals…")).toBeVisible();
  const popupBefore = await popup.boundingBox();
  const inputBefore = await search.boundingBox();
  const whileLoading = await geometry(dialog);
  release();
  await expect(
    popup.getByRole("button", { name: new RegExp(goal.title) }),
  ).toBeVisible();
  expect(await geometry(dialog)).toEqual(whileLoading);
  expect(await popup.boundingBox()).toEqual(popupBefore);
  expect(await search.boundingBox()).toEqual(inputBefore);
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(popup).toHaveCount(0);
  expect(await geometry(dialog)).toEqual(before);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(search).toBeFocused();
  await expect(
    popup.getByRole("button", { name: new RegExp(goal.title) }),
  ).toBeVisible();
  expect(await geometry(dialog)).toEqual(before);
  expect(reads).toBe(1);
  await search.press("Escape");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.getByRole("link", { name: "Plan", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Plan", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Focus", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Focus", exact: true }),
  ).toBeVisible();
  expect(reads).toBe(1);
});

test("Task goal assignments survive description, stage and date edits; Steps inherit and only explicit clear removes the link", async ({
  page,
  request,
}) => {
  const goal = await seedGoal(request);
  const task = await createResource(request, "tasks", {
    title: `Synthetic goal preservation ${crypto.randomUUID()}`,
    description: "Synthetic original description.",
  });
  const step = await createResource(request, "tasks", {
    title: `Synthetic inherited Step ${crypto.randomUUID()}`,
    parent_id: task.id,
    kind: "step",
  });
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  const trigger = dialog.getByRole("button", {
    name: "Associated goal",
    exact: true,
  });
  await trigger.click();
  const popup = page.getByRole("dialog", { name: "Goal picker", exact: true });
  await popup
    .getByRole("textbox", { name: "Search goals", exact: true })
    .fill(goal.title);
  await popup.getByRole("button", { name: new RegExp(goal.title) }).click();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
  await expect(trigger).toContainText(goal.title);
  await dialog
    .getByRole("combobox", { name: "Planning stage", exact: true })
    .selectOption("weekly");
  await dialog.getByRole("button", { name: "Date", exact: true }).click();
  await page.getByRole("button", { name: /^Tomorrow/u }).click();
  const description = dialog.getByRole("region", {
    name: "Task description",
    exact: true,
  });
  await description
    .getByRole("button", { name: "Edit description", exact: true })
    .click();
  await description
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Synthetic description retains its annual goal.");
  await description.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
  await expect(
    description.getByText("Synthetic description retains its annual goal."),
  ).toBeVisible();
  const saved = await (
    await request.get(`/api/tasks/v1/tasks/${task.id}`)
  ).json();
  expect(saved.key_result_id).toBe(goal.id);
  expect(saved.stage).toBe("weekly");
  expect(saved.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.goto(`/?task=${step.id}#/inbox`);
  const stepDialog = page.getByRole("dialog", {
    name: "Step details",
    exact: true,
  });
  await expect(
    stepDialog.getByRole("link", { name: goal.title, exact: true }),
  ).toHaveAttribute("href", `#/goals/${goal.id}`);
  await expect(
    stepDialog.getByRole("button", { name: "Associated goal", exact: true }),
  ).toHaveCount(0);
  await stepDialog
    .getByRole("textbox", { name: "Task name", exact: true })
    .fill("Synthetic edited inherited Step");
  await stepDialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(stepDialog.locator(".task-save-status")).toHaveText("Saved");
  expect(
    (await (await request.get(`/api/tasks/v1/tasks/${step.id}`)).json())
      .effective_key_result_id,
  ).toBe(goal.id);
  await stepDialog.getByRole("link", { name: goal.title, exact: true }).click();
  await expect(stepDialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#/goals/${goal.id}$`));
  await page.goto(`/?task=${task.id}#/inbox`);
  await trigger.click();
  await popup.getByRole("button", { name: "No goal", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
  expect(
    (await (await request.get(`/api/tasks/v1/tasks/${task.id}`)).json())
      .key_result_id ?? "",
  ).toBe("");
});

test("Plan reads joined Bet titles without a catalog read and text edits and clearing text keep the annual link", async ({
  page,
  request,
}) => {
  const goal = await seedGoal(request);
  const plan = await (await request.get("/api/tasks/v1/plan")).json();
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  const current = plan.weekly_bets?.find(
    (bet: { week_start: string; area: string }) =>
      bet.week_start === plan.week_start && bet.area === "work",
  );
  const seed = await request.patch(
    `/api/tasks/v1/weeklyBets/${plan.week_start}-work?update_mask=text,key_result_id&etag=${current?.etag ?? ""}`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: { text: "Synthetic weekly result", key_result_id: goal.id },
    },
  );
  expect(seed.status(), await seed.text()).toBe(200);
  let catalogs = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/tasks/v1/goalCatalog")
      catalogs++;
  });
  await page.goto("/#/plan");
  const goals = page.getByRole("region", { name: "Weekly goals", exact: true });
  const picker = goals.getByRole("button", {
    name: "Work associated goal",
    exact: true,
  });
  await expect(picker).toContainText(goal.title);
  expect(catalogs).toBe(0);
  const edit = goals.getByRole("button", {
    name: "Edit work goal: Synthetic weekly result",
    exact: true,
  });
  await edit.click();
  const input = goals.getByRole("textbox", {
    name: "This week's work goal",
    exact: true,
  });
  const before = await goals.boundingBox();
  await input.fill("Synthetic revised weekly result");
  await input.press("Enter");
  await expect(
    goals.getByRole("button", {
      name: "Edit work goal: Synthetic revised weekly result",
      exact: true,
    }),
  ).toBeFocused();
  expect(await goals.boundingBox()).toEqual(before);
  await expect(picker).toContainText(goal.title);
  expect(catalogs).toBe(0);
  await goals
    .getByRole("button", {
      name: "Edit work goal: Synthetic revised weekly result",
      exact: true,
    })
    .click();
  await input.fill("");
  await input.press("Enter");
  await expect(
    goals.getByRole("button", {
      name: "Write this week's work goal",
      exact: true,
    }),
  ).toBeVisible();
  await expect(picker).toContainText(goal.title);
  const updated = await (await request.get("/api/tasks/v1/plan")).json();
  expect(
    updated.weekly_bets.find(
      (bet: { week_start: string; area: string }) =>
        bet.week_start === plan.week_start && bet.area === "work",
    ),
  ).toMatchObject({ key_result_id: goal.id });
  await picker.click();
  await page
    .getByRole("dialog", { name: "Goal picker", exact: true })
    .getByRole("button", { name: "No goal", exact: true })
    .click();
  await expect(picker).not.toContainText(goal.title);
  expect(catalogs).toBe(1);
});
