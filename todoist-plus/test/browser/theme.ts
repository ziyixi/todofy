import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";

const require = createRequire(import.meta.url);
/** Every light theme class Todoist puts on <html>; "" is its default theme. Plus has no dark mode. */
export const THEMES = [
  "",
  "kale",
  "blueberry",
  "tangerine",
  "gold",
  "lavender",
  "moonstone",
  "raspberry",
] as const;

/**
 * Doist's public theme CSS (@doist/product-libraries-tokens, not live Todoist values): the
 * default theme and each of THEMES, so a test switches themes by the <html> class alone.
 */
export const themeCss = ["light", ...THEMES.filter(Boolean)]
  .map((name) =>
    readFileSync(
      require.resolve(`@doist/product-libraries-tokens/css/td-${name}.css`),
      "utf8",
    ),
  )
  .join("\n");

/** A colour token as the synthetic page computes it, e.g. "rgb(240, 246, 223)". */
export function tokenColor(page: Page, name: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(--product-library-${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);
}
