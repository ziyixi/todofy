/**
 * A page's title and summary, for a sitemap's new URL (Anthropic has no feed, design §3.2): the Open Graph or `<title>`
 * title, the meta or Open Graph description, else the start of the page's text; and the arXiv IDs and DOIs its links
 * name (mentions, design §4). One HTMLRewriter pass for the head, then the text extraction (page.ts).
 */
import { SUMMARY_MAX, TITLE_MAX } from '../limits.ts';
import { findMentions } from './feeds.ts';
import { extractPage } from './page.ts';
import { decodeBody, decodeEntities, detectCharset, oneLine } from './text.ts';

export interface PageMeta {
  readonly title: string;
  readonly description: string;
  readonly mentions: readonly string[];
}

export async function pageMeta(bytes: Uint8Array, contentType: string | null): Promise<PageMeta> {
  const charset = detectCharset(contentType, bytes);
  const html = decodeBody(bytes, charset);
  let ogTitle = '';
  let titleText = '';
  let description = '';
  let inTitle = false;
  const hrefs: string[] = [];
  const rewriter = new HTMLRewriter()
    .on('meta', {
      element(element) {
        const key = (element.getAttribute('property') ?? element.getAttribute('name') ?? '').toLowerCase();
        const content = element.getAttribute('content') ?? '';
        if (key === 'og:title' && ogTitle === '') ogTitle = content;
        if ((key === 'description' || key === 'og:description') && description === '') description = content;
      },
    })
    .on('title', {
      element(element) {
        inTitle = true;
        element.onEndTag(() => {
          inTitle = false;
        });
      },
      text(chunk) {
        if (inTitle) titleText += chunk.text;
      },
    })
    .on('a[href]', {
      element(element) {
        if (hrefs.length < 200) hrefs.push(element.getAttribute('href') ?? '');
      },
    });
  await rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })).arrayBuffer();
  const title = oneLine(decodeEntities(ogTitle !== '' ? ogTitle : titleText)).slice(0, TITLE_MAX);
  let summary = oneLine(decodeEntities(description));
  if (summary.length < 80) {
    const text = await extractPage(bytes, contentType);
    summary = text.slice(0, SUMMARY_MAX);
  }
  return { title, description: summary.slice(0, SUMMARY_MAX), mentions: findMentions(hrefs.join(' ')) };
}
