import Link from "next/link";

import { ArticleLanguages } from "@/components/ArticleLanguages";
import { groupPostsByTranslation, type Post } from "@/lib/content";
import styles from "@/styles/site.module.css";

interface BlogListProps {
  compact?: boolean;
  headingLevel?: 2 | 3;
  posts: Post[];
  limit?: number;
  preferredLanguage?: Post["language"];
}

export function formatPostDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(value));
}

export function BlogList({
  compact = false,
  headingLevel = 2,
  posts,
  limit,
  preferredLanguage = "en",
}: BlogListProps) {
  if (posts.length === 0) {
    return <p className={styles.emptyState}>Writing will appear here.</p>;
  }

  const groups = groupPostsByTranslation(posts, preferredLanguage).slice(0, limit);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <ol className={`${styles.blogList} ${compact ? styles.blogListCompact : ""}`}>
      {groups.map(({ id, primary: post, translations, publishedAt }) => (
        <li className={compact ? undefined : styles.blogListItemFull} key={id}>
          <time className={styles.postDate} dateTime={publishedAt}>
            {formatPostDate(publishedAt)}
          </time>
          <div>
            <Heading className={styles.postTitle}>
              <Link href={`/blog/${post.slug}`} hrefLang={post.language} lang={post.language}>
                {post.title}
              </Link>
            </Heading>
            {translations
              .filter((translation) => translation.slug !== post.slug)
              .map((translation) => (
                <p
                  className={styles.translationTitle}
                  key={translation.slug}
                  lang={translation.language}
                >
                  <Link href={`/blog/${translation.slug}`} hrefLang={translation.language}>
                    {translation.title}
                  </Link>
                </p>
              ))}
            <ArticleLanguages translations={translations} />
            {!compact ? (
              <p className={styles.postSummary} lang={post.language}>
                {post.summary}
              </p>
            ) : null}
            {!compact && post.tags.length > 0 ? (
              <ul aria-label="Tags" className={styles.tags}>
                {post.tags.slice(0, 4).map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
