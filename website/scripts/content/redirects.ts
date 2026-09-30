import { ContentError } from "../../src/lib/content/errors";
import { assertRedirectSourceDoesNotShadow } from "../../src/lib/content/redirect-path";
import type { Post, RedirectConfig, SnapshotRedirect } from "../../src/lib/content/schema";

export function resolveRedirects(
  configured: RedirectConfig[],
  posts: Post[],
  automatic: SnapshotRedirect[],
): SnapshotRedirect[] {
  const currentByKey = new Map(posts.map((post) => [post.sourceKey, post]));
  const currentPaths = new Set([
    "/",
    "/blog",
    "/publications",
    ...posts.map((post) => `/blog/${post.slug}`),
  ]);
  const resolved: SnapshotRedirect[] = [...automatic];

  for (const redirect of configured) {
    if (redirect.targetPostKey) {
      const target = currentByKey.get(redirect.targetPostKey);
      if (!target) continue;
      resolved.push({
        from: redirect.from,
        to: `/blog/${target.slug}`,
        status: 308,
        sourceKey: target.sourceKey,
      });
      continue;
    }
    if (!redirect.to) {
      throw new ContentError("INVALID_REDIRECT", `Redirect ${redirect.from} has no target.`);
    }
    resolved.push({ from: redirect.from, to: redirect.to, status: 308 });
  }

  const sources = new Set<string>();
  for (const redirect of resolved) {
    assertRedirectSourceDoesNotShadow(redirect.from, currentPaths);
    if (sources.has(redirect.from)) {
      throw new ContentError("DUPLICATE_REDIRECT", `Duplicate redirect source: ${redirect.from}`);
    }
    sources.add(redirect.from);
  }
  for (const redirect of resolved) {
    const targetPath = new URL(redirect.to, "https://internal.invalid").pathname;
    if (sources.has(targetPath)) {
      throw new ContentError("REDIRECT_CHAIN", `Redirect chains are not allowed: ${redirect.from}`);
    }
    if (!currentPaths.has(targetPath)) {
      throw new ContentError(
        "INVALID_REDIRECT_TARGET",
        `Redirect target does not identify a public route: ${redirect.to}`,
      );
    }
  }

  return resolved.sort((left, right) => left.from.localeCompare(right.from));
}
