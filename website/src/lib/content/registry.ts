import { ContentError } from "./errors";
import {
  ContentRegistrySchema,
  REGISTRY_VERSION,
  type ContentRegistry,
  type Post,
  type SnapshotRedirect,
} from "./schema";
import { postPath } from "./url";

export function emptyContentRegistry(): ContentRegistry {
  return { registryVersion: REGISTRY_VERSION, articleCount: 0, posts: [] };
}

export function buildCandidateRegistry(
  posts: Post[],
  baselineInput: ContentRegistry = emptyContentRegistry(),
): { registry: ContentRegistry; redirects: SnapshotRedirect[] } {
  const baseline = ContentRegistrySchema.parse(baselineInput);
  assertRegistryIntegrity(baseline);

  const currentKeys = new Set(posts.map((post) => post.sourceKey));
  const baselineByKey = new Map(baseline.posts.map((post) => [post.sourceKey, post]));
  const slugOwners = new Map<string, string>();

  for (const entry of baseline.posts) {
    for (const slug of new Set([entry.currentSlug, ...entry.historicalSlugs])) {
      const owner = slugOwners.get(slug);
      if (owner && owner !== entry.sourceKey) {
        throw new ContentError(
          "REGISTRY_SLUG_CONFLICT",
          `Historical slug ${slug} is owned by more than one source key.`,
          { slug },
        );
      }
      slugOwners.set(slug, entry.sourceKey);
    }
  }

  for (const post of posts) {
    const owner = slugOwners.get(post.slug);
    if (owner && owner !== post.sourceKey) {
      throw new ContentError(
        "HISTORICAL_SLUG_REUSE",
        `Slug ${post.slug} was previously used by another article.`,
        { slug: post.slug },
      );
    }
  }

  const entries: ContentRegistry["posts"] = posts.map((post) => {
    const previous = baselineByKey.get(post.sourceKey);
    const historicalSlugs = new Set(previous?.historicalSlugs ?? []);
    if (previous && previous.currentSlug !== post.slug) {
      historicalSlugs.add(previous.currentSlug);
    }
    historicalSlugs.delete(post.slug);
    return {
      sourceKey: post.sourceKey,
      currentSlug: post.slug,
      historicalSlugs: [...historicalSlugs].sort(),
      feedGuid: `urn:ziyixi:post:${post.sourceKey}`,
      published: true,
    };
  });

  for (const previous of baseline.posts) {
    if (currentKeys.has(previous.sourceKey)) continue;
    entries.push({ ...previous, published: false });
  }

  entries.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
  const registry = ContentRegistrySchema.parse({
    registryVersion: REGISTRY_VERSION,
    articleCount: posts.length,
    posts: entries,
  });
  assertRegistryIntegrity(registry);

  const redirects = registry.posts
    .filter((entry) => entry.published)
    .flatMap((entry) =>
      entry.historicalSlugs.map((slug) => ({
        from: postPath(slug),
        to: postPath(entry.currentSlug),
        status: 308 as const,
        sourceKey: entry.sourceKey,
      })),
    )
    .sort((left, right) => left.from.localeCompare(right.from));

  return { registry, redirects };
}

export function assertRegistryIntegrity(registry: ContentRegistry): void {
  if (registry.articleCount !== registry.posts.filter((post) => post.published).length) {
    throw new ContentError(
      "INVALID_REGISTRY",
      "Registry articleCount must equal the number of published entries.",
    );
  }
  const keys = new Set<string>();
  const slugs = new Map<string, string>();
  for (const post of registry.posts) {
    if (keys.has(post.sourceKey)) {
      throw new ContentError("INVALID_REGISTRY", `Duplicate registry sourceKey: ${post.sourceKey}`);
    }
    keys.add(post.sourceKey);
    if (post.feedGuid !== `urn:ziyixi:post:${post.sourceKey}`) {
      throw new ContentError("INVALID_REGISTRY", "Registry feed GUID does not match sourceKey.");
    }
    for (const slug of new Set([post.currentSlug, ...post.historicalSlugs])) {
      const owner = slugs.get(slug);
      if (owner && owner !== post.sourceKey) {
        throw new ContentError("INVALID_REGISTRY", `Registry slug has multiple owners: ${slug}`);
      }
      slugs.set(slug, post.sourceKey);
    }
  }
}
