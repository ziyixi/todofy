import { expect, test, type Locator, type Page } from "@playwright/test";
import { createTask, stubPlanning } from "./planning-stub";

// The title bar overlay exists only in an installed app window on a desktop OS. Headless Chromium cannot
// emulate `display-mode: window-controls-overlay` and has no `env(titlebar-area-*)`, so the query is stubbed
// (switchable, firing `change` as Chrome does when the owner toggles the bar) and the CSS fallbacks apply:
// a 33px strip across the whole window.
test.use({ serviceWorkers: "block" });

declare global {
  interface Window {
    setOverlay?: (on: boolean) => void;
  }
}

const QUERY = "(display-mode: window-controls-overlay)";

test.beforeEach(async ({ page }) => {
  await page.addInitScript((query) => {
    const native = window.matchMedia.bind(window);
    let on = true;
    const list = Object.defineProperties(new EventTarget(), {
      media: { value: query },
      matches: { get: () => on },
    });
    window.matchMedia = (media) =>
      media === query ? (list as unknown as MediaQueryList) : native(media);
    window.setOverlay = (value) => {
      on = value;
      list.dispatchEvent(new Event("change"));
    };
  }, QUERY);
});

const strip = (page: Page) => page.locator(".titlebar");
const titlebarSearch = (page: Page) =>
  strip(page).getByRole("searchbox", { name: "Search tasks", exact: true });
async function appRegion(locator: Locator) {
  return locator.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("-webkit-app-region"),
  );
}
/** The control lies inside the strip. */
async function inStrip(page: Page, control: Locator) {
  const bar = (await strip(page).boundingBox())!;
  const box = (await control.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(bar.y);
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height);
  expect(box.x + box.width).toBeLessThanOrEqual(bar.x + bar.width);
}

test("the strip drags the window and holds one search field and the page's refresh", async ({
  page,
  request,
}) => {
  const title = `Synthetic title bar ${crypto.randomUUID()}`;
  await createTask(request, { title });
  await page.goto("/#/today");
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  await expect(strip(page)).toBeVisible();
  expect(await appRegion(strip(page))).toBe("drag");
  expect(await appRegion(page.locator(".titlebar-search"))).toBe("no-drag");
  expect(
    await page.evaluate(
      () =>
        document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!
          .content,
    ),
  ).toBe("#ffffff");
  // The sidebar runs from the strip's bottom edge; its colour continues up through the strip.
  const bar = (await strip(page).boundingBox())!;
  expect(bar.height).toBe(33);
  expect((await page.locator(".sidebar").boundingBox())!.y).toBe(33);

  const refresh = page.getByRole("button", {
    name: "Refresh tasks",
    exact: true,
  });
  expect(await appRegion(refresh)).toBe("no-drag");
  await inStrip(page, refresh);
  const read = page.waitForRequest(
    (sent) =>
      sent.method() === "GET" &&
      new URL(sent.url()).searchParams.get("view") === "today",
  );
  await refresh.click();
  await read;

  // `/` puts the caret in the title bar; typing goes to Search with the text.
  await page.keyboard.press("/");
  await expect(titlebarSearch(page)).toBeFocused();
  await page.keyboard.type(title.slice(0, 30));
  await expect(page).toHaveURL(/#\/search$/u);
  await expect(
    page.getByRole("button", { name: title, exact: true }),
  ).toBeVisible();
  await expect(titlebarSearch(page)).toHaveValue(title.slice(0, 30));
  // One search field: Search shows none of its own.
  await expect(page.getByRole("textbox", { name: "Search tasks" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("searchbox", { name: "Search tasks" }),
  ).toHaveCount(1);

  // Another page clears the field; Search from the sidebar puts the caret back in it.
  await page.getByRole("link", { name: "Inbox", exact: true }).click();
  await expect(titlebarSearch(page)).toHaveValue("");
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await expect(titlebarSearch(page)).toBeFocused();
});

test("Plan's refresh moves into the strip too", async ({ page }) => {
  const state = await stubPlanning(page, {
    tasks: [
      {
        id: "titlebar-plan",
        title: "Synthetic title bar plan",
        area: "work",
        stage: "committed",
      },
    ],
  });
  await page.clock.setFixedTime(new Date(`${state.today}T18:00:00Z`));
  await page.goto("/#/plan");
  await expect(
    page.getByRole("region", { name: "Weekly goals" }),
  ).toBeVisible();
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await inStrip(page, refresh);
  expect(await appRegion(refresh)).toBe("no-drag");
  const reads = state.tasksRequests.length;
  await refresh.click();
  await expect
    .poll(() =>
      state.tasksRequests
        .slice(reads)
        .some((sent) => sent.path === "/api/tasks/v1/plan"),
    )
    .toBe(true);
  // The read has finished before the page closes.
  await expect(refresh.locator("svg")).not.toHaveClass(/plus-spin/u);
});

test("switching the overlay off restores the normal layout", async ({
  page,
}) => {
  await page.goto("/#/search");
  await expect(titlebarSearch(page)).toBeFocused();
  await page.evaluate(() => window.setOverlay!(false));
  await expect(strip(page)).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      document.documentElement.classList.contains("titlebar-overlay"),
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      () =>
        document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!
          .content,
    ),
  ).toBe("#f7f7f3");
  // Search's own field, and the refresh back in the page header.
  const search = page.getByRole("textbox", {
    name: "Search tasks",
    exact: true,
  });
  await expect(search).toBeFocused();
  const refresh = page.getByRole("button", {
    name: "Refresh tasks",
    exact: true,
  });
  const header = (await page.locator(".view-header").boundingBox())!;
  const box = (await refresh.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(header.y);
  expect(box.y + box.height).toBeLessThanOrEqual(header.y + header.height);
  expect((await page.locator(".sidebar").boundingBox())!.y).toBe(0);
  // And back on.
  await page.evaluate(() => window.setOverlay!(true));
  await expect(strip(page)).toBeVisible();
  await expect(search).toHaveCount(0);
  await inStrip(page, refresh);
});
