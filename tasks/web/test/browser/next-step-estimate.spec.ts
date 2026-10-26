import { expect, test } from "@playwright/test";
import { readFocus, stubPlanning, tasksToday } from "./planning-stub";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });

for (const execution of ["step", "standalone", "quick"] as const) {
  test(`${execution} shares the Next Step estimate panel and persists edits in Focus, Plan and task details`, async ({
    page,
    request,
  }) => {
    const today = await tasksToday(),
      id = `estimate-${execution}`,
      title = `Synthetic ${execution} action`;
    const parent = `estimate-parent-${execution}`;
    const state = await stubPlanning(page, {
      tasks: [
        { id: parent, title: "Synthetic estimate outcome", stage: "committed" },
        {
          id,
          title,
          kind: execution === "step" ? "step" : "task",
          ...(execution === "step"
            ? { parent_id: parent }
            : { stage: "committed" }),
          planning_flags:
            execution === "step"
              ? []
              : execution === "quick"
                ? ["quick"]
                : ["task"],
          due_date: today,
          due_datetime: `${today}T04:25:00Z`,
          due_timezone: "Asia/Tokyo",
        },
      ],
      queues: { [today]: [id] },
    });
    const before = await (
      await request.get(`/api/tasks/v1/tasks/${id}`)
    ).json();
    const writes: { mask: string | null; body: unknown }[] = [];
    page.on("request", (call) => {
      const url = new URL(call.url());
      if (
        call.method() === "PATCH" &&
        url.pathname === `/api/tasks/v1/tasks/${id}`
      )
        writes.push({
          mask: url.searchParams.get("update_mask"),
          body: call.postDataJSON(),
        });
    });
    await page.goto("/#/focus");
    const card = page.locator(`.plus-focus-slot[data-task-id="${id}"]`);
    await expect(
      card.getByRole("button", {
        name: `Complete task: ${title}`,
        exact: true,
      }),
    ).toBeVisible();
    await card.getByRole("button", { name: title, exact: true }).click();
    const panel = page.getByRole("dialog", { name: title, exact: true });
    const preset = panel.getByRole("button", { name: "60 min", exact: true });
    await expect(preset).toBeVisible();
    await expect(panel.getByRole("combobox")).toHaveCount(0);
    if (execution === "step")
      await expect(panel.getByLabel("Parent task")).toHaveText(
        "Synthetic estimate outcome",
      );
    const first = (await preset.boundingBox())!;
    await preset.click();
    await expect(preset).toHaveAttribute("aria-pressed", "true");
    await expect(preset).not.toHaveAttribute("aria-disabled", "true");
    expect(writes).toEqual([
      { mask: "duration_minutes", body: { duration_minutes: 60 } },
    ]);
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await card.getByRole("button", { name: title, exact: true }).click();
    await expect(preset).toHaveAttribute("aria-pressed", "true");
    const reopened = (await preset.boundingBox())!;
    expect(Math.abs(first.y - reopened.y)).toBeLessThan(1);
    expect(Math.abs(first.x - reopened.x)).toBeLessThan(1);
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    await card.getByRole("button", { name: title, exact: true }).click();
    await expect(preset).toHaveAttribute("aria-pressed", "true");
    await panel.getByRole("button", { name: "Close", exact: true }).click();

    await page.getByRole("link", { name: "Plan", exact: true }).click();
    await page.getByRole("tab", { name: "Week", exact: true }).click();
    const scheduled = page.locator(
      `.planning-calendar-day[data-date="${today}"] .planning-calendar-step[data-task-id="${id}"]`,
    );
    await expect(
      scheduled.locator(".planning-calendar-step-meta strong"),
    ).toHaveText("13:25");
    await scheduled.getByRole("button", { name: title, exact: true }).click();
    await expect(preset).toHaveAttribute("aria-pressed", "true");
    await panel
      .getByRole("spinbutton", { name: "Estimate", exact: true })
      .fill("47");
    await panel
      .getByRole("spinbutton", { name: "Estimate", exact: true })
      .press("Enter");
    await expect(
      panel.getByRole("spinbutton", { name: "Estimate", exact: true }),
    ).not.toHaveAttribute("aria-disabled", "true");
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await scheduled.getByRole("button", { name: title, exact: true }).click();
    await expect(
      panel.getByRole("spinbutton", { name: "Estimate", exact: true }),
    ).toHaveValue("47");
    expect(writes).toEqual([
      { mask: "duration_minutes", body: { duration_minutes: 60 } },
      { mask: "duration_minutes", body: { duration_minutes: 47 } },
    ]);
    await panel.getByRole("button", { name: "Open task", exact: true }).click();
    const native = page.getByRole("dialog", {
      name: execution === "step" ? "Step details" : "Task details",
      exact: true,
    });
    const duration = native.getByRole("spinbutton", {
      name: "Duration (minutes)",
      exact: true,
    });
    await expect(duration).toHaveValue("47");
    expect(
      await duration.evaluate((field: HTMLInputElement) =>
        field.checkValidity(),
      ),
    ).toBe(true);
    await duration.fill("90");
    await native
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(native).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "90 min", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(
      scheduled.locator(".planning-calendar-step-meta strong"),
    ).toHaveText("13:25");
    const after = await (await request.get(`/api/tasks/v1/tasks/${id}`)).json();
    expect(after.duration_minutes).toBe(90);
    for (const field of [
      "kind",
      "parent_id",
      "planning_flags",
      "due_date",
      "due_datetime",
      "due_timezone",
    ])
      expect(after[field]).toEqual(before[field]);
    const days = (await readFocus(today, today)).days as {
      task_ids?: string[];
    }[];
    expect(days[0]?.task_ids).toEqual([id]);
    expect(
      state.tasksRequests.filter((call) => call.method === "DELETE"),
    ).toEqual([]);
  });
}
