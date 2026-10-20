import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("a tab whose bundle calls a route the Worker no longer has asks for a reload instead of an error", async ({
  page,
}) => {
  // The dev server names no build, so the route's answer alone tells this tab that it is outdated.
  await page.route("**/api/tasks/v1/catalog", (route) =>
    route.continue({
      url: route.request().url().replace("/catalog", "/retiredCatalog"),
    }),
  );
  await page.goto("/#/inbox");
  const prompt = page
    .getByRole("alert")
    .filter({ hasText: "Tasks was updated." });
  await expect(prompt).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Unknown API route")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  await page.unroute("**/api/tasks/v1/catalog");
  await prompt.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  await expect(prompt).toHaveCount(0);
});
