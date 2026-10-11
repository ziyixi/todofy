/**
 * Full text from an article page (../../../docs/design.md §6): one streaming HTMLRewriter pass over the body after its
 * charset is decided (the header's, else a BOM, a meta or XML declaration: HTMLRewriter decodes only by the header).
 *
 * - The text is the page's `<article>`, else its `<main>`, else its `<body>`, with its headings as paragraphs of their
 *   own (marked `## `, so the cut below can find a conclusion);
 * - dropped: `head`, `script`, `style`, `noscript`, `template`, `svg`, `iframe`, `nav`, `aside`, `footer`, `form`,
 *   `button` and every attribute (`</head>` is optional in HTML: the `body` start tag closes an open head), and an
 *   element hidden by its own markup (`hidden`, `aria-hidden="true"`, an inline `display: none` or `visibility:
 *   hidden`): a reader never sees it, and text planted for a summarizer hides there;
 * - each MathML element is replaced by its `alttext` (arXiv's HTML carries a formula twice and garbles it as text);
 * - character references are decoded (HTMLRewriter hands text chunks over as source text).
 *
 * HTMLRewriter builds no tree: an element's end is seen only when its end tag comes (onEndTag throws on void elements,
 * which are never registered), so the depth counters below follow the tags it reports. An element keeps one end-tag
 * handler, the last registered: the counters of `article`, `main` and hidden elements register after the paragraph
 * breaks, so a `<p hidden>` or the `<article>` (both also block elements) still closes its counter.
 */
import { CONCLUSION_SHARE, DOCUMENT_CHARS } from '../limits.ts';
import { decodeBody, decodeEntities, detectCharset } from './text.ts';

const SKIP = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'nav', 'aside', 'footer', 'form', 'button', 'select', 'textarea', 'object'];
const BLOCK = ['p', 'div', 'section', 'li', 'blockquote', 'pre', 'td', 'th', 'dd', 'dt', 'figcaption', 'caption', 'tr', 'article', 'main', 'table', 'ul', 'ol'];
const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
/** Void elements have no end tag (onEndTag throws on them): a hidden one hides nothing anyway. */
const VOID = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].map((tag) => `:not(${tag})`).join('');
const HIDDEN = ['[hidden]', '[aria-hidden="true"]', '[style*="display:none"]', '[style*="display: none"]', '[style*="visibility:hidden"]', '[style*="visibility: hidden"]'].map((selector) => `${selector}${VOID}`).join(', ');

interface Collector {
  /** Text per scope: article, main, body. */
  readonly scopes: Record<'article' | 'main' | 'body', string[]>;
  skip: number;
  article: number;
  main: number;
  math: number;
  heading: number;
}

function push(c: Collector, text: string): void {
  if (c.skip > 0 || c.math > 0) return;
  c.scopes.body.push(text);
  if (c.main > 0) c.scopes.main.push(text);
  if (c.article > 0) c.scopes.article.push(text);
}

/** The readable text of an HTML page's bytes (paragraphs separated by blank lines). */
export async function extractPage(bytes: Uint8Array, contentType: string | null): Promise<string> {
  const charset = detectCharset(contentType, bytes);
  let body: Uint8Array = bytes;
  let label = charset;
  if (charset === 'utf-16le' || charset === 'utf-16be') {
    body = new TextEncoder().encode(decodeBody(bytes, charset));
    label = 'utf-8';
  }
  const c: Collector = { scopes: { article: [], main: [], body: [] }, skip: 0, article: 0, main: 0, math: 0, heading: 0 };
  const depth = (field: 'skip' | 'article' | 'main' | 'math' | 'heading', before?: () => void) => ({
    element(element: Element) {
      before?.();
      c[field] += 1;
      element.onEndTag(() => {
        c[field] -= 1;
        if (field === 'heading') push(c, '\n\n');
      });
    },
  });
  let headOpen = false;
  let rewriter = new HTMLRewriter()
    .on('head', {
      element(element) {
        headOpen = true;
        c.skip += 1;
        element.onEndTag(() => {
          if (!headOpen) return;
          headOpen = false;
          c.skip -= 1;
        });
      },
    })
    .on('body', {
      element() {
        if (!headOpen) return;
        headOpen = false;
        c.skip -= 1;
      },
    })
    .on(SKIP.join(', '), depth('skip'))
    .on(HEADINGS.join(', '), depth('heading', () => {
      push(c, '\n\n## ');
    }))
    .on('math', {
      element(element) {
        const alt = element.getAttribute('alttext');
        if (alt !== null && alt.trim() !== '') push(c, ` ${alt.trim()} `);
        c.math += 1;
        element.onEndTag(() => {
          c.math -= 1;
        });
      },
    })
    .on('br', {
      element() {
        push(c, '\n');
      },
    });
  for (const tag of BLOCK) {
    rewriter = rewriter.on(tag, {
      element(element) {
        push(c, '\n\n');
        element.onEndTag(() => {
          push(c, '\n\n');
        });
      },
    });
  }
  rewriter = rewriter.on('article', depth('article')).on('main', depth('main')).on(HIDDEN, depth('skip'));
  rewriter = rewriter.onDocument({
    text(chunk) {
      if (chunk.text !== '') push(c, decodeEntities(chunk.text));
    },
  });
  const response = rewriter.transform(new Response(body, { headers: { 'content-type': `text/html; charset=${label}` } }));
  await response.arrayBuffer();
  const pick = c.scopes.article.join('').trim().length > 400 ? c.scopes.article : c.scopes.main.join('').trim().length > 400 ? c.scopes.main : c.scopes.body;
  return paragraphs(pick.join(''));
}

/** Text with whitespace collapsed inside paragraphs and blank lines between them. */
export function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/[ \t\r\f\v\u00a0]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim())
    .filter((paragraph) => paragraph !== '' && paragraph !== '##')
    .join('\n\n');
}

const CONCLUSION = /^##\s*(?:\d+(?:\.\d+)*\.?\s*)?(conclusions?|discussion|summary|concluding remarks|结论|讨论|总结)\b/i;

/**
 * A document cut to `max` characters (design §6): the start (the abstract and the introduction) and, when a heading
 * names it, the conclusion or discussion, which keeps up to a quarter of the budget. The cut is marked `[…]`; a quote
 * never spans it (quotes are checked against this very text).
 */
export function cutDocument(text: string, max: number = DOCUMENT_CHARS): string {
  if (text.length <= max) return text;
  const blocks = text.split('\n\n');
  const at = blocks.findIndex((block, index) => index > 0 && CONCLUSION.test(block));
  if (at < 0) return `${text.slice(0, max - 4).trimEnd()} […]`;
  const tail = blocks.slice(at).join('\n\n');
  const tailBudget = Math.min(tail.length, Math.floor(max * CONCLUSION_SHARE));
  const headBudget = max - tailBudget - 8;
  const head = blocks.slice(0, at).join('\n\n');
  return `${head.slice(0, headBudget).trimEnd()}\n\n[…]\n\n${tail.slice(0, tailBudget).trimEnd()}`;
}
