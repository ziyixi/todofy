/**
 * Stage 2 of the noise pipeline (../../../docs/design.md §5): from an answer's bytes to the source's raw lines (and
 * items), with the parts of the health gate that need the decoded text (wrong content type, selector miss, too short,
 * mojibake, parse errors). Every source kind goes through here, for a check and for PreviewWatch alike.
 *
 * The charset is decided first (charset.ts): the header's, else a BOM, else the `<meta charset>` of the first 2 KiB,
 * and an HTML body is handed to HTMLRewriter relabelled with it, so a GBK page that names its encoding only in a meta
 * tag decodes. A wrong label still shows: U+FFFD over the mojibake threshold fails the check.
 */
import type { SourceConfig } from '../config.ts';
import { contentTypeFits, isMojibake, isTooShort, type FailureCode } from '../health.ts';
import { detectCharset, decodeBody, mediaType, relabelled, type Charset } from './charset.ts';
import { parseFeed } from './feed.ts';
import { extractHtml, scriptTexts, type HtmlBlock } from './html.ts';
import { markdownLines } from './markdown.ts';
import { jsonValues, parseJson, readJsonLd, type Item } from './structured.ts';

export type { Item } from './structured.ts';

/** What a source yields before normalization. */
export interface RawPage {
  /** The lines in document order (entities decoded; whitespace and masks are stage 3's). */
  readonly lines: string[];
  /** Feed and JSON items with their keys; null for a page's text (its lines are its items). */
  readonly items: Item[] | null;
  /** The schema.org availability (JSON-LD), or null. */
  readonly availability: string | null;
  /** Lines beyond LINES_MAX were dropped. */
  readonly truncated: boolean;
}

export interface ExtractInfo {
  readonly charset: Charset;
  readonly mediaType: string;
  /** The site answered markdown. */
  readonly markdown: boolean;
  /** The page's blocks (HTML only, when asked for). */
  readonly blocks: HtmlBlock[];
}

export type Extraction = { readonly ok: true; readonly page: RawPage; readonly info: ExtractInfo } | { readonly ok: false; readonly failure: FailureCode; readonly info: ExtractInfo };

export interface ExtractOptions {
  readonly source: SourceConfig;
  readonly contentType: string | null;
  readonly body: Uint8Array;
  /** The page's final URL (links resolve against it). */
  readonly url: string;
  /** Collect the blocks of an HTML page (PreviewWatch). */
  readonly blocks: boolean;
}

/** Whether a source accepts a markdown answer (the Accept header of config.ts acceptFor). */
function markdownAllowed(source: SourceConfig): boolean {
  return source.kind === 'html' && source.include.length === 0 && source.exclude.length === 0;
}

/** Stage 2 with its health checks. */
export async function extract(options: ExtractOptions): Promise<Extraction> {
  const { source, body } = options;
  const type = mediaType(options.contentType);
  const charset = detectCharset(options.contentType, body);
  const info: { charset: Charset; mediaType: string; markdown: boolean; blocks: HtmlBlock[] } = { charset, mediaType: type, markdown: false, blocks: [] };
  const fail = (failure: FailureCode): Extraction => ({ ok: false, failure, info });
  const done = (page: RawPage): Extraction => ({ ok: true, page, info });
  if (!contentTypeFits(source, type, markdownAllowed(source))) return fail('WRONG_CONTENT_TYPE');

  switch (source.kind) {
    case 'html': {
      if (type === 'text/markdown') {
        info.markdown = true;
        const text = decodeBody(body, charset.label);
        if (isMojibake(text)) return fail('MOJIBAKE');
        const { lines, truncated } = markdownLines(text, source.keepLinks, options.url);
        if (isTooShort(lines)) return fail('TOO_SHORT');
        return done({ lines, items: null, availability: null, truncated });
      }
      const result = await extractHtml(relabelled(body, charset.label), {
        include: source.include,
        exclude: source.exclude,
        keepLinks: source.keepLinks,
        keepLandmarks: source.keepLandmarks,
        blocks: options.blocks,
        baseUrl: options.url,
      });
      info.blocks = result.blocks;
      if (isMojibake(result.lines.join('\n'))) return fail('MOJIBAKE');
      if (!result.includeMatched) return fail('SELECTOR_MISS');
      // A whole page must be long enough to be the page; a selected part (a price) only must not be empty.
      if (source.include.length === 0 ? isTooShort(result.lines) : result.lines.length === 0) return fail('TOO_SHORT');
      return done({ lines: result.lines, items: null, availability: null, truncated: result.truncated });
    }
    case 'embedded': {
      const selector = source.embedded === 'json_ld' ? 'script[type="application/ld+json"]' : 'script#__NEXT_DATA__';
      const texts = await scriptTexts(relabelled(body, charset.label), selector, 50);
      if (texts.some(isMojibake)) return fail('MOJIBAKE');
      const structured = source.embedded === 'json_ld' ? readJsonLd(texts, source.path) : texts[0] === undefined ? null : jsonValuesOf(parseJson(texts[0]), source.path);
      if (structured === null || structured.lines.length === 0) return fail('PARSE_ERROR');
      return done({ lines: structured.lines, items: structured.items, availability: structured.availability, truncated: false });
    }
    case 'feed': {
      const text = decodeBody(body, charset.label);
      if (isMojibake(text)) return fail('MOJIBAKE');
      const feed = parseFeed(text, source.includeSummaries);
      if (!feed.ok) return fail('PARSE_ERROR');
      return done({ lines: feed.items.map((item) => item.text), items: feed.items, availability: null, truncated: false });
    }
    case 'json': {
      const text = decodeBody(body, charset.label);
      const values = jsonValuesOf(parseJson(text), source.path);
      if (values === null || values.lines.length === 0) return fail('PARSE_ERROR');
      if (isMojibake(values.lines.join('\n'))) return fail('MOJIBAKE');
      return done({ lines: values.lines, items: values.items, availability: null, truncated: false });
    }
  }
}

function jsonValuesOf(document: unknown, path: string): ReturnType<typeof jsonValues> {
  return document === undefined ? null : jsonValues(document, path);
}
