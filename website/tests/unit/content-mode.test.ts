import { describe, expect, it } from "vitest";

import { assertModeBoundary, parseExplicitSource } from "../../scripts/content/mode";

describe("explicit content modes", () => {
  it("does not infer a source from credentials", () => {
    expect(() => parseExplicitSource(undefined)).toThrow(/content source is required/i);
    expect(parseExplicitSource("empty")).toBe("empty");
  });

  it("allows empty without Notion and requires credentials for notion", () => {
    expect(() => assertModeBoundary("empty", { forRelease: false })).not.toThrow();
    expect(() => assertModeBoundary("notion", { forRelease: false })).toThrow(
      /requires NOTION_TOKEN/,
    );
  });

  it("forbids fixture at the trusted release boundary", () => {
    expect(() =>
      assertModeBoundary("fixture", {
        forRelease: true,
        notionToken: "unused",
        notionDataSourceId: "unused",
      }),
    ).toThrow(/cannot be used/);
  });
});
