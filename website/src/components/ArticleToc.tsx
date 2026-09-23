import type { Post } from "@/lib/content";
import styles from "@/styles/site.module.css";

type ArticleTocProps = Pick<Post, "language" | "toc">;

export function ArticleToc({ language, toc }: ArticleTocProps) {
  if (toc.length === 0) return null;

  return (
    <details className={styles.toc}>
      <summary>{language === "zh-CN" ? "本文目录" : "On this page"}</summary>
      <ol>
        {toc.map((entry) => (
          <li
            className={
              entry.level === 4
                ? styles.tocLevel4
                : entry.level === 3
                  ? styles.tocLevel3
                  : undefined
            }
            key={entry.id}
          >
            <a href={`#${entry.id}`}>{entry.text}</a>
          </li>
        ))}
      </ol>
    </details>
  );
}
