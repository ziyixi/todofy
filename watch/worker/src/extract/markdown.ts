/**
 * A page a site answered as markdown (`Accept: text/markdown`, a rendering for agents that many sites behind Cloudflare
 * offer): its text as lines, without the markdown syntax that is form, not content. Pure; bounded by LINES_MAX.
 *
 * Kept: every paragraph, heading, list item and table row as a line of its text. Dropped: emphasis and code markers,
 * heading and list markers, images, HTML comments and raw tags, front matter and the separator rows of tables. A link
 * reads as its text, or `text <url>` with HtmlSource.keep_links (relative addresses resolved against the page).
 */
import { LINE_MAX, LINES_MAX } from '../limits.ts';

function resolve(href: string, base: string): string {
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : href;
  } catch {
    return href;
  }
}

/** One markdown line as text. */
function inline(line: string, keepLinks: boolean, base: string): string {
  return line
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, (_, label: string, href: string) => (keepLinks && href !== '' ? `${label} <${resolve(href, base)}>` : label))
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .trim();
}

/** The lines of a markdown document. */
export function markdownLines(markdown: string, keepLinks: boolean, base: string): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;
  let text = markdown.replace(/\r\n?/g, '\n');
  // Front matter.
  text = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (line === '' || /^(```|~~~)/.test(line) || /^[-*_]{3,}$/.test(line) || /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line)) continue;
    line = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, '');
    if (line.startsWith('|')) line = line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()).join(' | ');
    const out = inline(line, keepLinks, base);
    if (out === '') continue;
    if (lines.length >= LINES_MAX) {
      truncated = true;
      break;
    }
    lines.push(out.length > LINE_MAX ? out.slice(0, LINE_MAX) : out);
  }
  return { lines, truncated };
}
