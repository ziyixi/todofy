import { expect, type Locator, type Page } from "@playwright/test";

export async function beginTaskDrag(page: Page, source: Locator) {
  // Wait for the previous drop to release this row, then start from a stable, visible surface.
  await expect
    .poll(() =>
      source.evaluate((e) => {
        const row = e.closest(".task-row,.task-child-row");
        const handle = row?.querySelector<HTMLButtonElement>(
          ".drag-handle,.child-drag",
        );
        return (
          !!handle &&
          !handle.disabled &&
          !row?.classList.contains("is-dragging")
        );
      }),
    )
    .toBe(true);
  await source.evaluate((e) =>
    e.scrollIntoView({ block: "center", inline: "nearest" }),
  );
  await source.hover();
  const bounds = await source.boundingBox();
  if (!bounds) throw new Error("Drag source is not visible");
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + Math.min(14, bounds.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 8, y, { steps: 3 });
  await expect(page.locator(".task-drag-preview")).toBeVisible();
}

export async function dropTaskOn(
  page: Page,
  target: Locator,
  position: "before" | "inside" | "after" = "before",
) {
  // dnd-kit auto-scrolls the task list while the pointer is in its outer fifth, which carries a
  // target there away from the pointer. Centre the target, even a fully visible one.
  await target.evaluate((e) =>
    e.scrollIntoView({ block: "center", inline: "nearest" }),
  );
  const zone = target.locator(`:scope > .task-drop-zone.drop-${position}`);
  const destination = (await zone.count()) ? zone : target;
  const bounds = await destination.boundingBox();
  if (!bounds) throw new Error("Drop target is not visible");
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
    { steps: 8 },
  );
  if ((await zone.count()) || (await target.getAttribute("role")) === "region")
    await expect(destination).toHaveClass(/is-over/);
  else await expect(target).toHaveAttribute("data-task-drop", "true");
  await page.mouse.up();
  await expect(page.locator(".task-drag-preview")).toHaveCount(0);
}

export async function dragTask(
  page: Page,
  source: Locator,
  target: Locator,
  position: "before" | "inside" | "after" = "before",
) {
  await beginTaskDrag(page, source);
  await dropTaskOn(page, target, position);
}
