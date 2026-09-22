import type { PreparedSource, SourceContext } from "../types";

export async function prepareEmptySource(context: SourceContext): Promise<PreparedSource> {
  void context;
  return {
    posts: [],
    media: [],
    diagnostics: { draftCount: 0, futureCount: 0, warnings: [] },
  };
}
