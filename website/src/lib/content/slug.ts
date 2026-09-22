import { ContentError } from "./errors";

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const RESERVED_SLUGS = new Set([
  "about",
  "api",
  "blog",
  "build-info",
  "cv",
  "feed",
  "publications",
  "robots",
  "sitemap",
]);

export function validateSlug(input: string): string {
  if (input !== input.trim()) {
    throw new ContentError("INVALID_SLUG", "Slug cannot contain surrounding whitespace.", {
      slug: input,
    });
  }
  if (input.length === 0 || input.length > 80 || !SLUG_PATTERN.test(input)) {
    throw new ContentError(
      "INVALID_SLUG",
      "Slug must contain only lowercase ASCII letters, digits, and single hyphens.",
      { slug: input },
    );
  }
  if (RESERVED_SLUGS.has(input)) {
    throw new ContentError("RESERVED_SLUG", `Slug is reserved: ${input}`, {
      slug: input,
    });
  }
  return input;
}

export function assertUniqueSlugs(slugs: Iterable<string>): void {
  const seen = new Set<string>();
  for (const slug of slugs) {
    validateSlug(slug);
    if (seen.has(slug)) {
      throw new ContentError("DUPLICATE_SLUG", `Duplicate slug: ${slug}`, { slug });
    }
    seen.add(slug);
  }
}
