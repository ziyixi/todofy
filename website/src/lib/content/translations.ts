import { ContentError } from "./errors";
import type { Post } from "./schema";

const LANGUAGE_ORDER: Record<Post["language"], number> = { en: 0, "zh-CN": 1 };

export interface PostTranslationGroup {
  id: string;
  primary: Post;
  translations: Post[];
  publishedAt: string;
}

function compareTranslationLanguages(left: Post, right: Post): number {
  return LANGUAGE_ORDER[left.language] - LANGUAGE_ORDER[right.language];
}

// Callers pass the public snapshot, never the unfiltered Notion collection.
export function getPostTranslations(posts: Post[], post: Post): Post[] {
  if (!post.translationKey) return [post];
  return posts
    .filter((candidate) => candidate.translationKey === post.translationKey)
    .sort(compareTranslationLanguages);
}

export function groupPostsByTranslation(
  posts: Post[],
  preferredLanguage: Post["language"] = "en",
): PostTranslationGroup[] {
  const groups = new Map<string, Post[]>();
  for (const post of posts) {
    const id = post.translationKey
      ? `translation:${post.translationKey}`
      : `post:${post.sourceKey}`;
    const translations = groups.get(id) ?? [];
    translations.push(post);
    groups.set(id, translations);
  }

  return [...groups]
    .map(([id, translations]) => {
      translations.sort(compareTranslationLanguages);
      const primary =
        translations.find((post) => post.language === preferredLanguage) ?? translations[0]!;
      // Publishing a translation should not make an old article look newly written.
      const publishedAt = translations.reduce(
        (earliest, post) => (post.publishedAt < earliest ? post.publishedAt : earliest),
        primary.publishedAt,
      );
      return { id, primary, translations, publishedAt };
    })
    .sort(
      (left, right) =>
        right.publishedAt.localeCompare(left.publishedAt) || left.id.localeCompare(right.id),
    );
}

export function assertUniqueTranslationLanguages(
  posts: Array<Pick<Post, "slug" | "language" | "translationKey">>,
): void {
  const groups = new Map<string, Map<Post["language"], string>>();
  for (const post of posts) {
    if (!post.translationKey) continue;
    const languages = groups.get(post.translationKey) ?? new Map<Post["language"], string>();
    const previousSlug = languages.get(post.language);
    if (previousSlug) {
      throw new ContentError(
        "DUPLICATE_TRANSLATION_LANGUAGE",
        `TranslationKey "${post.translationKey}" has two published ${post.language} pages: ${previousSlug} and ${post.slug}. Give unrelated articles different keys.`,
      );
    }
    languages.set(post.language, post.slug);
    groups.set(post.translationKey, languages);
  }
}
