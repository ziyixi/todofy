import katex from "katex";
import type { CSSProperties, ReactNode } from "react";
import { codeToHtml, type BundledLanguage } from "shiki";

import { ExpandableArticleImage } from "@/components/ExpandableArticleImage";
import type { CodeBlock, ContentBlock, ListItemBlock, Post, RichTextSpan } from "@/lib/content";
import { KATEX_SAFE_OPTIONS } from "@/lib/content/equation";
import { trustedVideoEmbedUrl } from "@/lib/content/video-embed";
import { ArticleToc } from "@/components/ArticleToc";
import styles from "@/styles/article.module.css";

interface ArticleBodyProps {
  blocks: ContentBlock[];
  language?: Post["language"];
  toc?: Post["toc"];
}

const supportedCodeLanguages = new Set([
  "bash",
  "c",
  "cpp",
  "css",
  "go",
  "html",
  "javascript",
  "json",
  "markdown",
  "python",
  "rust",
  "shell",
  "sql",
  "text",
  "tsx",
  "typescript",
  "yaml",
]);

function InlineEquation({ expression }: { expression: string }) {
  const html = katex.renderToString(expression, {
    ...KATEX_SAFE_OPTIONS,
    displayMode: false,
  });
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function RichText({ allowLinks = true, spans }: { allowLinks?: boolean; spans: RichTextSpan[] }) {
  return spans.map((span, index) => {
    let content: ReactNode = span.equation ? <InlineEquation expression={span.text} /> : span.text;
    if (span.code) content = <code>{content}</code>;
    if (span.bold) content = <strong>{content}</strong>;
    if (span.italic) content = <em>{content}</em>;
    if (span.strikethrough) content = <s>{content}</s>;
    if (span.underline) content = <u>{content}</u>;
    if (span.href && allowLinks) content = <a href={span.href}>{content}</a>;
    return <span key={`${index}-${span.text.slice(0, 20)}`}>{content}</span>;
  });
}

async function HighlightedCode({ block }: { block: CodeBlock }) {
  if (!supportedCodeLanguages.has(block.language)) {
    return (
      <pre data-language={block.language} tabIndex={0}>
        <code>{block.code}</code>
      </pre>
    );
  }

  const html = await codeToHtml(block.code, {
    lang: block.language as BundledLanguage,
    theme: "github-light-high-contrast",
  });
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

function ListGroup({ items }: { items: ListItemBlock[] }) {
  const Tag = items[0]?.style === "numbered" ? "ol" : "ul";
  return (
    <Tag>
      {items.map((item) => (
        <li key={item.id}>
          <RichText spans={item.richText} />
          {item.children.length > 0 ? <BlockSequence blocks={item.children} /> : null}
        </li>
      ))}
    </Tag>
  );
}

function BlockSequence({ blocks }: { blocks: ContentBlock[] }) {
  const rendered: ReactNode[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    if (block.type === "listItem") {
      const items = [block];
      while (blocks[index + 1]?.type === "listItem") {
        const sibling = blocks[index + 1];
        if (!sibling || sibling.type !== "listItem" || sibling.style !== block.style) break;
        items.push(sibling);
        index += 1;
      }
      rendered.push(<ListGroup items={items} key={`list-${block.id}`} />);
      continue;
    }
    rendered.push(<ArticleBlock block={block} key={block.id} />);
  }
  return rendered;
}

function ArticleBlock({ block }: { block: Exclude<ContentBlock, ListItemBlock> }) {
  switch (block.type) {
    case "paragraph":
      return (
        <>
          {block.richText.length > 0 ? (
            <p>
              <RichText spans={block.richText} />
            </p>
          ) : (
            <div aria-hidden="true" className={styles.emptyParagraph} />
          )}
          {block.children.length > 0 ? <BlockSequence blocks={block.children} /> : null}
        </>
      );
    case "heading": {
      const children = <RichText spans={block.richText} />;
      if (block.toggleable) {
        const Heading = block.level === 2 ? "h2" : block.level === 3 ? "h3" : "h4";
        return (
          <details className={styles.toggleHeading} open>
            <summary>
              <Heading id={block.anchor}>{children}</Heading>
            </summary>
            <div className={styles.toggleBody}>
              <BlockSequence blocks={block.children ?? []} />
            </div>
          </details>
        );
      }
      if (block.level === 2) return <h2 id={block.anchor}>{children}</h2>;
      if (block.level === 3) return <h3 id={block.anchor}>{children}</h3>;
      return <h4 id={block.anchor}>{children}</h4>;
    }
    case "toDo":
      return (
        <div className={styles.toDo}>
          <input
            aria-label={
              block.richText
                .map((span) => span.text)
                .join("")
                .trim() || "Task"
            }
            checked={block.checked}
            disabled
            readOnly
            type="checkbox"
          />
          <div>
            <RichText spans={block.richText} />
            {block.children.length > 0 ? <BlockSequence blocks={block.children} /> : null}
          </div>
        </div>
      );
    case "columns": {
      const columnTemplate = block.columns.map((column) => `${column.widthRatio ?? 1}fr`).join(" ");
      return (
        <div
          className={styles.columns}
          style={{ "--column-template": columnTemplate } as CSSProperties}
        >
          {block.columns.map((column) => (
            <div className={styles.column} key={column.id}>
              <BlockSequence blocks={column.children} />
            </div>
          ))}
        </div>
      );
    }
    case "tableOfContents":
      return null;
    case "quote":
      return (
        <blockquote>
          <p>
            <RichText spans={block.richText} />
          </p>
          {block.children.length > 0 ? <BlockSequence blocks={block.children} /> : null}
        </blockquote>
      );
    case "divider":
      return <hr />;
    case "code":
      return (
        <figure className={styles.codeBlock}>
          <HighlightedCode block={block} />
          {block.caption.length > 0 ? (
            <figcaption>
              <RichText spans={block.caption} />
            </figcaption>
          ) : null}
        </figure>
      );
    case "equation": {
      const html = katex.renderToString(block.expression, {
        ...KATEX_SAFE_OPTIONS,
        displayMode: true,
      });
      return (
        <div
          aria-label={`Equation: ${block.expression}`}
          className={styles.equation}
          dangerouslySetInnerHTML={{ __html: html }}
          role="math"
        />
      );
    }
    case "image":
      return (
        <figure>
          <ExpandableArticleImage
            alt={block.alt}
            height={block.height}
            mediaPath={block.mediaPath}
            width={block.width}
          />
          {block.caption.length > 0 ? (
            <figcaption>
              <RichText spans={block.caption} />
            </figcaption>
          ) : null}
        </figure>
      );
    case "mediaFile": {
      const href = block.source.type === "local" ? block.source.mediaPath : block.source.href;
      const external = block.source.type === "external";
      const trustedEmbed =
        block.kind === "video" && external ? trustedVideoEmbedUrl(href) : undefined;
      const directMedia = !external || isDirectMediaUrl(href, block.kind);
      let content: ReactNode;
      if (trustedEmbed) {
        content = <TrustedVideoFrame src={trustedEmbed} title={block.name} />;
      } else if (block.kind === "audio" && directMedia) {
        content = (
          <audio controls preload="none" src={href}>
            <a href={href}>Open {block.name}</a>
          </audio>
        );
      } else if (block.kind === "video" && directMedia) {
        content = (
          <video controls playsInline preload="metadata" src={href}>
            <a href={href}>Open {block.name}</a>
          </video>
        );
      } else {
        content = null;
      }
      return (
        <figure className={styles.mediaBlock}>
          {content}
          <a
            className={styles.mediaLink}
            download={!external && block.kind === "file" ? block.name : undefined}
            href={href}
            rel={external || block.kind === "pdf" ? "noopener noreferrer" : undefined}
            target={external || block.kind === "pdf" ? "_blank" : undefined}
          >
            {block.kind === "pdf" ? `Open PDF: ${block.name}` : block.name}
          </a>
          {block.caption.length > 0 ? (
            <figcaption>
              <RichText spans={block.caption} />
            </figcaption>
          ) : null}
        </figure>
      );
    }
    case "embed": {
      const trustedEmbed = trustedVideoEmbedUrl(block.href);
      const title =
        block.caption
          .map((span) => span.text)
          .join("")
          .trim() || "Embedded video";
      return (
        <figure className={styles.mediaBlock}>
          {trustedEmbed ? <TrustedVideoFrame src={trustedEmbed} title={title} /> : null}
          <a className={styles.mediaLink} href={block.href}>
            {block.caption.length > 0 ? (
              <RichText allowLinks={false} spans={block.caption} />
            ) : (
              block.href
            )}
          </a>
        </figure>
      );
    }
    case "table":
      return (
        <div
          className={styles.tableScroll}
          role="region"
          aria-label="Scrollable table"
          tabIndex={0}
        >
          <table>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${block.id}-row-${rowIndex}`}>
                  {row.map((cell, columnIndex) => {
                    const isColumnHeader = block.hasColumnHeader && rowIndex === 0;
                    const isRowHeader = block.hasRowHeader && columnIndex === 0;
                    const Cell = isColumnHeader || isRowHeader ? "th" : "td";
                    return (
                      <Cell
                        key={`${block.id}-${rowIndex}-${columnIndex}`}
                        scope={isColumnHeader ? "col" : isRowHeader ? "row" : undefined}
                      >
                        <RichText spans={cell} />
                      </Cell>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "toggle":
      return (
        <details>
          <summary>
            <RichText spans={block.richText} />
          </summary>
          <div className={styles.toggleBody}>
            <BlockSequence blocks={block.children} />
          </div>
        </details>
      );
    case "callout":
      return (
        <aside className={styles.callout}>
          <p>
            {block.icon ? <span aria-hidden="true">{block.icon} </span> : null}
            <RichText spans={block.richText} />
          </p>
          {block.children.length > 0 ? <BlockSequence blocks={block.children} /> : null}
        </aside>
      );
    case "bookmark":
      return (
        <p className={styles.bookmark}>
          <a href={block.href}>
            {block.caption.length > 0 ? (
              <RichText allowLinks={false} spans={block.caption} />
            ) : (
              block.href
            )}
          </a>
        </p>
      );
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

function TrustedVideoFrame({ src, title }: { src: string; title: string }) {
  return (
    <iframe
      allow="encrypted-media; picture-in-picture"
      allowFullScreen
      className={styles.videoFrame}
      loading="lazy"
      referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-presentation"
      src={src}
      title={title}
    />
  );
}

function isDirectMediaUrl(href: string, kind: string): boolean {
  if (kind !== "audio" && kind !== "video") return false;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    return kind === "audio"
      ? /\.(?:mp3|m4a|ogg|oga|wav)$/i.test(url.pathname)
      : /\.(?:mp4|webm|ogv)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function ArticleBody({ blocks, language = "en", toc = [] }: ArticleBodyProps) {
  const sections: ReactNode[] = [];
  let pending: ContentBlock[] = [];
  const flushPending = () => {
    if (pending.length > 0) {
      sections.push(<BlockSequence blocks={pending} key={`blocks-${pending[0]?.id}`} />);
      pending = [];
    }
  };
  for (const block of blocks) {
    if (block.type === "tableOfContents") {
      flushPending();
      sections.push(<ArticleToc key={block.id} language={language} toc={toc} />);
    } else {
      pending.push(block);
    }
  }
  flushPending();

  return <div className={styles.articleBody}>{sections}</div>;
}
