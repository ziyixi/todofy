import { ContentError } from "../../src/lib/content/errors";
import { ContentSourceModeSchema } from "../../src/lib/content/schema";
import type { SourceMode } from "./types";

export function parseExplicitSource(value: string | undefined): SourceMode {
  if (!value) {
    throw new ContentError(
      "MISSING_SOURCE_MODE",
      "A content source is required. Pass --source=empty, --source=fixture, or --source=notion.",
    );
  }
  const parsed = ContentSourceModeSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContentError("INVALID_SOURCE_MODE", `Unknown content source: ${value}`);
  }
  return parsed.data;
}

export function assertModeBoundary(
  mode: SourceMode,
  options: { forRelease: boolean; notionToken?: string; notionDataSourceId?: string },
): void {
  if (mode === "fixture" && options.forRelease) {
    throw new ContentError(
      "FIXTURE_RELEASE_FORBIDDEN",
      "fixture mode is synthetic and cannot be used by the trusted release entrypoint.",
    );
  }
  if (mode === "notion" && (!options.notionToken || !options.notionDataSourceId)) {
    throw new ContentError(
      "MISSING_NOTION_CREDENTIALS",
      "notion mode requires NOTION_TOKEN and NOTION_DATA_SOURCE_ID; it never falls back to empty.",
    );
  }
}
