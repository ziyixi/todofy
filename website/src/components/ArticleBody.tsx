import katex from "katex";
import Image from "next/image";
import type { ReactNode } from "react";
import { codeToHtml, type BundledLanguage } from "shiki";

import type { CodeBlock, ContentBlock, ListItemBlock, RichTextSpan } from "@/lib/content";
import { KATEX_SAFE_OPTIONS } from "@/lib/content/equation";
import styles from "@/styles/article.module.css";

interface ArticleBodyProps {
  blocks: ContentBlock[];
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
      <pre data-language={block.language}>
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
      if (block.level === 2) return <h2 id={block.anchor}>{children}</h2>;
      if (block.level === 3) return <h3 id={block.anchor}>{children}</h3>;
      return <h4 id={block.anchor}>{children}</h4>;
    }
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
          <Image
            alt={block.alt}
            height={block.height}
            sizes="(max-width: 719px) calc(100vw - 40px), 680px"
            src={block.mediaPath}
            width={block.width}
          />
          {block.caption.length > 0 ? (
            <figcaption>
              <RichText spans={block.caption} />
            </figcaption>
          ) : null}
        </figure>
      );
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

export function ArticleBody({ blocks }: ArticleBodyProps) {
  return (
    <div className={styles.articleBody}>
      <BlockSequence blocks={blocks} />
    </div>
  );
}
