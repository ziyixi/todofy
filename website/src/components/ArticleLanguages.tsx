import Link from "next/link";

import type { Post } from "@/lib/content";
import styles from "@/styles/site.module.css";

const labels: Record<Post["language"], string> = { en: "English", "zh-CN": "中文" };

export function ArticleLanguages({
  translations,
  currentSlug,
}: {
  translations: Post[];
  currentSlug?: string;
}) {
  if (translations.length < 2) return null;
  const Container = currentSlug ? "nav" : "div";

  return (
    <Container
      aria-label="Article language / 文章语言"
      className={styles.articleLanguages}
      role={currentSlug ? undefined : "group"}
    >
      {translations.map((translation) =>
        translation.slug === currentSlug ? (
          <span aria-current="page" key={translation.slug} lang={translation.language}>
            {labels[translation.language]}
          </span>
        ) : (
          <Link
            href={`/blog/${translation.slug}`}
            hrefLang={translation.language}
            key={translation.slug}
            lang={translation.language}
          >
            {labels[translation.language]}
          </Link>
        ),
      )}
    </Container>
  );
}
