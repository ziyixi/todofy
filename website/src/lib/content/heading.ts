import type { RichTextSpan } from "./schema";

export const RESERVED_ARTICLE_ANCHOR_IDS = new Set(["main-content"]);

export function normalizeHeadingText(spans: ReadonlyArray<Pick<RichTextSpan, "text">>): string {
  return spans
    .map((span) => span.text)
    .join("")
    .trim();
}
