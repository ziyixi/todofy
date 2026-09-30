import katex, { type KatexOptions } from "katex";

import { ContentError } from "./errors";

export const KATEX_SAFE_OPTIONS = {
  output: "htmlAndMathml",
  strict: "error",
  throwOnError: true,
  trust: false,
} as const satisfies KatexOptions;

export function validateKatexExpression(expression: string, displayMode: boolean): string {
  if (!expression.trim()) {
    throw new ContentError(
      "INVALID_EQUATION",
      `${displayMode ? "Block" : "Inline"} equation cannot be empty.`,
    );
  }

  try {
    katex.renderToString(expression, {
      ...KATEX_SAFE_OPTIONS,
      displayMode,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ContentError(
      "INVALID_EQUATION",
      `Invalid ${displayMode ? "block" : "inline"} equation: ${reason}`,
      { displayMode },
    );
  }

  return expression;
}
