import { expect, test } from "@playwright/test";
import { launchPlanner } from "./planner-setup";
import { THEMES } from "./theme";

/** Each --plus-* colour and the Todoist token whose role it takes. */
const ROLES = {
  bg: "background-base-primary",
  surface: "background-base-tertiary",
  text: "display-primary-idle-tint",
  muted: "display-secondary-idle-tint",
  line: "divider-primary",
  hover: "actionable-quaternary-hover-fill",
  accent: "actionable-tertiary-idle-tint",
  "accent-fill": "actionable-primary-idle-fill",
  "on-accent": "actionable-primary-on-idle-tint",
  selected: "selectable-secondary-selected-fill",
  "selected-text": "selectable-secondary-on-selected-tint",
  "nav-selected-text": "selectable-secondary-on-selected-fill",
  warning: "info-warning-primary-on-idle-tint",
  danger: "schedule-overdue-tint",
  p1: "priorities-p1-primary-idle-tint",
  p2: "priorities-p2-primary-idle-tint",
  p3: "priorities-p3-primary-idle-tint",
  p4: "priorities-p4-primary-idle-tint",
  overlay: "background-overlay",
} as const;
type Role = keyof typeof ROLES;

/** "rgb(…)", "rgba(…)" or, from color-mix(), "color(srgb r g b / a)" with 0–1 channels. */
function channels(color: string) {
  const values = color.match(/[\d.]+/gu)!.map(Number);
  const scale = color.startsWith("color(srgb") ? 255 : 1;
  const [r = 0, g = 0, b = 0] = values.map((value) => value * scale);
  return { r, g, b, a: values[3] ?? 1 };
}
function luminance(color: string, under = "rgb(255, 255, 255)") {
  const top = channels(color);
  const bottom = channels(under);
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  // A translucent colour is seen over what is underneath.
  const mix = (key: "r" | "g" | "b") =>
    linear(top[key] * top.a + bottom[key] * (1 - top.a));
  return 0.2126 * mix("r") + 0.7152 * mix("g") + 0.0722 * mix("b");
}
function contrast(text: string, background: string) {
  const [light, dark] = [luminance(text, background), luminance(background)]
    .sort((a, b) => b - a)
    .map((value) => value + 0.05);
  return light! / dark!;
}

test("Plus follows every light Todoist theme through CSS alone, with readable text", async () => {
  const { context } = await launchPlanner();
  try {
    const page = await context.newPage();
    // Lanes and cards fade their backgrounds; read the settled colours.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    await page.locator('.review-board [data-outcome-id="quarter"]').click();
    await expect(page.locator(".plus-dialog .plus-primary")).toBeVisible();
    // Class, then styles, in one task: no observer pass or script can run in between.
    const read = (theme: string) =>
      page.evaluate(
        ({ theme, roles }) => {
          document.documentElement.className = theme ? `theme_${theme}` : "";
          const root = document.querySelector("todoist-plus-view")!.shadowRoot!;
          const nav = document
            .querySelector("todoist-plus-navigation")!
            .shadowRoot!.querySelector('button[aria-current="page"]')!;
          const inner = root.appendChild(document.createElement("span"));
          const outer = document.body.appendChild(
            document.createElement("span"),
          );
          const color = (element: HTMLElement, value: string) => {
            element.style.color = value;
            return getComputedStyle(element).color;
          };
          const style = (selector: string) =>
            getComputedStyle(root.querySelector(selector)!);
          const result = {
            roles: Object.fromEntries(
              Object.entries(roles).map(([role, token]) => [
                role,
                {
                  plus: color(inner, `var(--plus-${role})`),
                  todoist: color(outer, `var(--product-library-${token})`),
                },
              ]),
            ),
            root: [
              style(".plus-root").backgroundColor,
              style(".plus-root").color,
            ],
            nav: [
              getComputedStyle(nav).backgroundColor,
              getComputedStyle(nav).color,
            ],
            lane: style(".review-lane").backgroundColor,
            muted: style(".review-lane-header > span").color,
            link: style(".planning-label-button").color,
            priority: style('.planning-priority-mark[data-priority="4"]').color,
            primary: [
              style(".plus-primary").backgroundColor,
              style(".plus-primary").color,
            ],
          };
          inner.remove();
          outer.remove();
          return result;
        },
        { theme, roles: ROLES },
      );
    for (const theme of THEMES) {
      const seen = await read(theme);
      const todoist = (role: Role) => seen.roles[role]!.todoist;
      for (const [role, { plus, todoist: token }] of Object.entries(seen.roles))
        expect(plus, `${theme || "default"}: --plus-${role}`).toBe(token);
      expect(seen.root).toEqual([todoist("bg"), todoist("text")]);
      expect(seen.nav).toEqual([
        todoist("selected"),
        todoist("nav-selected-text"),
      ]);
      expect(seen.lane).toBe(todoist("surface"));
      expect(seen.muted).toBe(todoist("muted"));
      expect(seen.link).toBe(todoist("accent"));
      expect(seen.priority).toBe(todoist("p1"));
      expect(seen.primary).toEqual([
        todoist("accent-fill"),
        todoist("on-accent"),
      ]);
      // WCAG AA for 12-14px text, for each pair Plus composes. On the selected fill all text,
      // muted too, is selected-text, so accent and muted never sit on it.
      for (const [text, background] of [
        ["text", "bg"],
        ["text", "surface"],
        ["text", "selected"],
        ["muted", "bg"],
        ["muted", "surface"],
        ["accent", "bg"],
        ["warning", "bg"],
        // Days past a deadline, on cards, in the weekly review and in task details.
        ["danger", "bg"],
        ["on-accent", "accent-fill"],
        ["selected-text", "selected"],
      ] as const)
        expect(
          contrast(todoist(text), todoist(background)),
          `${theme || "default"}: ${text} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      // 3:1 for focus rings, insert lines and drop borders, on every surface they cross.
      for (const background of ["bg", "surface", "selected"] as const)
        expect(
          contrast(todoist("accent"), todoist(background)),
          `${theme || "default"}: accent line on ${background}`,
        ).toBeGreaterThanOrEqual(3);
      await test.info().attach(`theme-${theme || "default"}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    }
    // Week: today's number, the selected day's weekday and the selected outcome's meta,
    // measured where Plus draws them.
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Week", exact: true }).click();
    await expect(
      page.locator(".planning-calendar-day.is-today.is-selected"),
    ).toBeVisible();
    await expect(
      page.locator(".planning-outcome-card.is-selected"),
    ).toBeVisible();
    for (const theme of THEMES) {
      const pairs = await page.evaluate((theme) => {
        document.documentElement.className = theme ? `theme_${theme}` : "";
        const root = document.querySelector("todoist-plus-view")!.shadowRoot!;
        // The colour, and the first opaque background behind it.
        const seen = (selector: string) => {
          const element = root.querySelector(selector)!;
          let behind: Element | null = element;
          let background = "rgba(0, 0, 0, 0)";
          while (behind && /^rgba\(.*, 0\)$/u.test(background)) {
            background = getComputedStyle(behind).backgroundColor;
            behind = behind.parentElement;
          }
          return [getComputedStyle(element).color, background] as const;
        };
        return {
          today: seen(
            ".planning-calendar-day.is-today .planning-day-heading > strong",
          ),
          weekday: seen(
            ".planning-calendar-day.is-selected .planning-day-heading > span",
          ),
          meta: seen(
            ".planning-outcome-card.is-selected .planning-outcome-meta",
          ),
        };
      }, theme);
      for (const [name, [text, background]] of Object.entries(pairs))
        expect(
          contrast(text, background),
          `${theme || "default"}: ${name} ${text} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
    }
    // Without any token, the fallbacks keep the earlier light look.
    const fallback = await page.evaluate(() => {
      document.querySelector<HTMLStyleElement>("#todoist-theme")!.disabled =
        true;
      document.documentElement.className = "";
      const root = document.querySelector("todoist-plus-view")!.shadowRoot!;
      const probe = root.appendChild(document.createElement("span"));
      const colors = ["bg", "text", "selected", "accent"].map((role) => {
        probe.style.color = `var(--plus-${role})`;
        return getComputedStyle(probe).color;
      });
      probe.remove();
      return colors;
    });
    expect(fallback).toEqual([
      "rgb(255, 255, 255)",
      "rgb(32, 32, 32)",
      "rgb(240, 246, 223)",
      "rgb(85, 121, 33)",
    ]);
  } finally {
    await context.close();
  }
});
