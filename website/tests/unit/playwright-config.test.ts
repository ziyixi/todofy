import { describe, expect, it } from "vitest";

import playwrightConfig from "../../playwright.config";

describe("Playwright browser projects", () => {
  it("keeps every chromium-named project on the Chromium engine installed by CI", () => {
    const projects = playwrightConfig.projects ?? [];
    expect(projects.map((project) => project.name)).toEqual([
      "desktop-chromium",
      "mobile-chromium",
    ]);
    for (const project of projects) {
      if (project.name?.endsWith("-chromium")) {
        expect(project.use?.defaultBrowserType).toBe("chromium");
      }
    }
  });
});
