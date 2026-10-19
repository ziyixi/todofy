import { expect, test, type Locator } from "@playwright/test";

const DATE_HELP = "YYYY-MM-DD, e.g. 2030-04-15, or tomorrow.";

async function describedDateInput(picker: Locator, name: string) {
  const input = picker.getByRole("textbox", { name, exact: true });
  await expect(input).toHaveAttribute("placeholder", "YYYY-MM-DD or tomorrow");
  await expect(input).toHaveAccessibleDescription(DATE_HELP);
  await expect(picker.getByText(DATE_HELP, { exact: true })).toBeVisible();
  await expect(picker.getByRole("grid")).toBeVisible();
  await expect(
    picker.getByRole("button", { name: /^Tomorrow\b/ }),
  ).toBeVisible();
  return input;
}

test("Date and Deadline explain accepted input in task details and contextual choosers", async ({
  page,
  request,
}) => {
  const csrf = await request.get("/api/tasks/csrf");
  const { token } = await csrf.json();
  const response = await request.post(
    `/api/tasks/v1/tasks?request_id=${crypto.randomUUID()}`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: { title: `Synthetic date format guidance ${crypto.randomUUID()}` },
    },
  );
  expect(response.status()).toBe(200);
  const task = (await response.json()) as { id: string; title: string };
  await page.goto(`/?task=${task.id}#/inbox`);
  const details = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await details.getByRole("button", { name: "Date", exact: true }).click();
  const datePicker = page.getByRole("dialog", {
    name: "Date picker",
    exact: true,
  });
  const dateInput = await describedDateInput(datePicker, "Schedule");
  await dateInput.fill("2030-04-15");
  await dateInput.press("Enter");
  await expect(datePicker.getByRole("status")).toHaveText("Next: 2030-04-15");
  await details.getByRole("button", { name: "Date", exact: true }).click();
  await details.getByRole("button", { name: "Deadline", exact: true }).click();
  const deadlinePicker = page.getByRole("dialog", {
    name: "Deadline picker",
    exact: true,
  });
  const deadlineInput = await describedDateInput(
    deadlinePicker,
    "Deadline text",
  );
  await deadlineInput.fill("2030-04-22");
  await deadlineInput.press("Enter");
  await expect(deadlinePicker).not.toBeVisible();
  await details
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(details.locator(".task-save-status")).toHaveText("Saved");
  await details
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(details).not.toBeVisible();
  let saved = await (
    await request.get(`/api/tasks/v1/tasks/${task.id}`)
  ).json();
  expect(saved.due_date).toBe("2030-04-15");
  expect(saved.deadline).toBe("2030-04-22");

  await page.goto("/#/inbox");
  const row = page
    .locator(".task-row")
    .filter({ has: page.getByText(task.title, { exact: true }) });
  await row
    .getByRole("button", {
      name: `More actions for ${task.title}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "More dates", exact: true }).click();
  const contextDateInput = await describedDateInput(datePicker, "Schedule");
  await contextDateInput.fill("2030-04-16");
  await contextDateInput.press("Enter");
  await expect(datePicker).not.toBeVisible();
  saved = await (await request.get(`/api/tasks/v1/tasks/${task.id}`)).json();
  expect(saved.due_date).toBe("2030-04-16");
  expect(saved.deadline).toBe("2030-04-22");

  await row
    .getByRole("button", {
      name: `More actions for ${task.title}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Deadline", exact: true }).click();
  const contextDeadlineInput = await describedDateInput(
    deadlinePicker,
    "Deadline text",
  );
  await contextDeadlineInput.fill("2030-04-30");
  await contextDeadlineInput.press("Enter");
  await expect(deadlinePicker).not.toBeVisible();
  saved = await (await request.get(`/api/tasks/v1/tasks/${task.id}`)).json();
  expect(saved.deadline).toBe("2030-04-30");
  expect(saved.due_date).toBe("2030-04-16");
  await page.reload();
  await row
    .getByRole("button", {
      name: `More actions for ${task.title}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Deadline", exact: true }).click();
  await describedDateInput(deadlinePicker, "Deadline text");
});
