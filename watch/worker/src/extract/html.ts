/**
 * Stage 2 for HTML sources (../../../docs/design.md §5): a page's visible text, one line per block, from one streaming
 * HTMLRewriter pass, and (for PreviewWatch) the blocks with a selector each.
 *
 * What HTMLRewriter does and does not do (measured in workerd, test/runtime/extract.test.ts):
 * - text chunks are source text: character references stay encoded (decoded here, entities.ts), and the text of
 *   `<script>`, `<style>` and the other dropped elements still arrives: a depth counter keeps it out;
 * - it builds no tree: an element closed implicitly (`<p>one<p>two`, `<li>` without `</li>`) is closed only when its
 *   parent's end tag comes, so the next `<p>` is its child. Its own selector matching uses that same tree, and so do
 *   the frames here (one per start tag, popped in `onEndTag`), so a selector made from them matches what they saw;
 * - `onEndTag` on a void element (`<br>`, `<img>`, a self-closed SVG child) throws: such elements are never pushed.
 *
 * Dropped: `head`, `script`, `style`, `noscript`, `template`, `svg`, `iframe`, `textarea` and every attribute; the
 * landmark regions (`nav`, `role` navigation, banner or contentinfo, and the body's own `header` and `footer`) unless
 * HtmlSource.keep_landmarks. With include selectors only text inside one of them counts; text inside an exclude
 * selector never does. A line ends at the start or end of a block element and at `<br>`/`<hr>`.
 */
import { LINE_MAX, LINES_MAX, PREVIEW_BLOCKS_MAX, PREVIEW_TEXT_MAX } from '../limits.ts';
import { decodeEntities } from './entities.ts';

export interface HtmlOptions {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly keepLinks: boolean;
  readonly keepLandmarks: boolean;
  /** Collect PreviewWatch's blocks too (a little more work per element). */
  readonly blocks: boolean;
  /** The page's URL, to resolve link addresses. */
  readonly baseUrl: string;
}

export interface HtmlBlock {
  readonly selector: string;
  readonly tag: string;
  readonly text: string;
  readonly lineCount: number;
  readonly counted: boolean;
  readonly landmark: boolean;
}

export interface HtmlExtraction {
  /** The counted lines (raw: entities decoded, whitespace not yet normalized). */
  readonly lines: string[];
  /** An include selector matched at least one element (true without include selectors). */
  readonly includeMatched: boolean;
  readonly blocks: HtmlBlock[];
  /** More lines than LINES_MAX: the rest were dropped. */
  readonly truncated: boolean;
}

/** Elements whose content is never text the owner reads. */
const SKIP = new Set(['head', 'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'textarea', 'object']);
/** Elements without an end tag (onEndTag throws for them). */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Elements that start a new line. */
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'li', 'main', 'nav', 'ol',
  'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'html', 'legend',
]);
const LANDMARK_ROLES = new Set(['navigation', 'banner', 'contentinfo']);
/** An id that looks generated (a long number, a hash, a CSS-module or BEM name) makes a poor selector; `reviews` does not. */
const UNSTABLE_NAME = /\d{3,}|(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,}|^[a-z]{1,4}-(?=[a-z0-9]*\d)[a-z0-9]{4,}$|__|--/i;
const SELECTOR_MAX_CHARS = 200;

interface Frame {
  readonly tag: string;
  readonly id: string;
  readonly parent: Frame | null;
  /** 1-based position among the parent's children of the same tag (HTMLRewriter's :nth-of-type). */
  readonly nthOfType: number;
  readonly typeCounts: Map<string, number>;
  readonly block: boolean;
  readonly serial: number;
  skip: boolean;
  landmark: boolean;
  include: boolean;
  exclude: boolean;
  href: string | null;
  selector: string | null;
}

/** A selector for `frame` in HTMLRewriter's subset: an id anchor or `body`, then child steps with :nth-of-type. */
export function selectorOf(frame: Frame): string {
  const steps: string[] = [];
  let node: Frame = frame;
  for (;;) {
    if (node.id !== '' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(node.id) && !UNSTABLE_NAME.test(node.id)) {
      steps.unshift(`${node.tag}#${node.id}`);
      break;
    }
    if (node.tag === 'body' || node.parent === null) {
      steps.unshift(node.tag);
      break;
    }
    steps.unshift(`${node.tag}:nth-of-type(${String(node.nthOfType)})`);
    node = node.parent;
  }
  const selector = steps.join(' > ');
  if (selector.length <= SELECTOR_MAX_CHARS) return selector;
  // Too deep: the element's own step under its nearest anchor, as a descendant.
  return `${steps[0] ?? 'body'} ${steps[steps.length - 1] ?? frame.tag}`.slice(0, SELECTOR_MAX_CHARS);
}

/** Whether HTMLRewriter accepts `selector` (it throws at registration for anything outside its subset). */
export function supportedSelector(selector: string): boolean {
  if (selector.trim() === '' || selector.length > SELECTOR_MAX_CHARS) return false;
  try {
    new HTMLRewriter().on(selector, {});
    return true;
  } catch {
    return false;
  }
}

/** Runs the extraction over a response whose Content-Type names the body's charset (charset.ts relabelled). */
export async function extractHtml(response: Response, options: HtmlOptions): Promise<HtmlExtraction> {
  const lines: string[] = [];
  const blocks: { selector: string; tag: string; text: string; lineCount: number; counted: boolean; landmark: boolean; serial: number }[] = [];
  let truncated = false;
  let includeMatched = options.include.length === 0;
  let top: Frame | null = null;
  // The frame of the element whose start tag the handlers are on (null for a void element): the selectors' marks.
  let current: Frame | null = null;
  let serial = 0;
  let skipDepth = 0;
  let includeDepth = 0;
  let excludeDepth = 0;
  let landmarkDepth = 0;
  // The line being collected: raw source text, and the block frame it belongs to.
  let raw = '';
  let lineFrame: Frame | null = null;
  let lineCounted = false;
  let lineLandmark = false;

  const counted = () => skipDepth === 0 && (options.include.length === 0 || includeDepth > 0) && excludeDepth === 0 && (options.keepLandmarks || landmarkDepth === 0);
  const blockFrame = (): Frame | null => {
    let node = top;
    while (node !== null && !node.block) node = node.parent;
    return node;
  };

  const endLine = () => {
    const text = decodeEntities(raw).replace(/\s+/g, ' ').trim();
    raw = '';
    if (text === '') return;
    const line = text.length > LINE_MAX ? text.slice(0, LINE_MAX) : text;
    if (lineCounted) {
      if (lines.length < LINES_MAX) lines.push(line);
      else truncated = true;
    }
    if (options.blocks && lineFrame !== null) {
      const last = blocks[blocks.length - 1];
      if (last?.serial === lineFrame.serial && last.counted === lineCounted) {
        last.lineCount += 1;
        if (last.text.length < PREVIEW_TEXT_MAX) last.text = `${last.text} ${line}`.slice(0, PREVIEW_TEXT_MAX);
      } else if (blocks.length < PREVIEW_BLOCKS_MAX) {
        lineFrame.selector ??= selectorOf(lineFrame);
        blocks.push({ selector: lineFrame.selector, tag: lineFrame.tag, text: line.slice(0, PREVIEW_TEXT_MAX), lineCount: 1, counted: lineCounted, landmark: lineLandmark, serial: lineFrame.serial });
      }
    }
  };

  const rewriter = new HTMLRewriter()
    .on('*', {
      element(element) {
        const tag = element.tagName.toLowerCase();
        if (tag === 'br' || tag === 'hr' || BLOCK.has(tag)) endLine();
        current = null;
        if (VOID.has(tag)) return;
        const parent = top;
        const nth = (parent?.typeCounts.get(tag) ?? 0) + 1;
        parent?.typeCounts.set(tag, nth);
        const role = (element.getAttribute('role') ?? '').trim().toLowerCase();
        const frame: Frame = {
          tag,
          id: (element.getAttribute('id') ?? '').trim(),
          parent,
          nthOfType: nth,
          typeCounts: new Map(),
          block: BLOCK.has(tag),
          serial: ++serial,
          skip: SKIP.has(tag),
          landmark: tag === 'nav' || LANDMARK_ROLES.has(role) || ((tag === 'header' || tag === 'footer') && parent?.tag === 'body'),
          include: false,
          exclude: false,
          href: options.keepLinks && tag === 'a' ? element.getAttribute('href') : null,
          selector: null,
        };
        try {
          element.onEndTag(() => {
            if (frame.block || frame.href !== null) {
              if (frame.href !== null && counted()) raw += ` <${resolveHref(frame.href, options.baseUrl)}>`;
              if (frame.block) endLine();
            }
            if (frame.skip) skipDepth -= 1;
            if (frame.include) includeDepth -= 1;
            if (frame.exclude) excludeDepth -= 1;
            if (frame.landmark) landmarkDepth -= 1;
            top = frame.parent;
          });
        } catch {
          // A self-closed foreign element (`<path/>` in SVG): no end tag, so it is not a frame.
          return;
        }
        top = frame;
        current = frame;
        if (frame.skip) skipDepth += 1;
        if (frame.landmark) landmarkDepth += 1;
      },
    })
    .onDocument({
      text(chunk) {
        // The text of a dropped element (a script inside a paragraph) never touches the line.
        if (chunk.text === '' || skipDepth > 0) return;
        const frame = blockFrame();
        const isCounted = counted();
        if (raw !== '' && (frame !== lineFrame || isCounted !== lineCounted)) endLine();
        if (raw === '') {
          lineFrame = frame;
          lineCounted = isCounted;
          lineLandmark = landmarkDepth > 0;
        }
        raw += chunk.text;
      },
    });
  // The selectors run after '*' for the same element, so the frame they mark is the one just pushed.
  const mark = (key: 'include' | 'exclude') => ({
    element() {
      const frame = current;
      if (frame === null || frame[key]) return;
      frame[key] = true;
      if (key === 'include') {
        includeDepth += 1;
        includeMatched = true;
      } else {
        excludeDepth += 1;
      }
    },
  });
  for (const selector of options.include) rewriter.on(selector, mark('include'));
  for (const selector of options.exclude) rewriter.on(selector, mark('exclude'));
  await rewriter.transform(response).arrayBuffer();
  endLine();
  return {
    lines,
    includeMatched,
    truncated,
    blocks: blocks.map((block) => ({ selector: block.selector, tag: block.tag, text: block.text, lineCount: block.lineCount, counted: block.counted, landmark: block.landmark })),
  };
}

/** An `<a href>` as an absolute http(s) URL for the line, or the value as written when it is not one. */
function resolveHref(href: string, base: string): string {
  try {
    const url = new URL(decodeEntities(href.trim()), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : href.trim();
  } catch {
    return href.trim();
  }
}

/** The text of every element matching `selector` (script contents included), joined per element; at most `max`. */
export async function scriptTexts(response: Response, selector: string, max: number): Promise<string[]> {
  const texts: string[] = [];
  let current: string | null = null;
  let total = 0;
  await new HTMLRewriter()
    .on(selector, {
      element(element) {
        current = '';
        try {
          element.onEndTag(() => {
            if (current !== null && texts.length < max) texts.push(current);
            current = null;
          });
        } catch {
          current = null;
        }
      },
      text(chunk) {
        if (current === null || total > 2 * 1024 * 1024) return;
        current += chunk.text;
        total += chunk.text.length;
      },
    })
    .transform(response)
    .arrayBuffer();
  return texts;
}
