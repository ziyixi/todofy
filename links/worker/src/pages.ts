/**
 * The small pages the short-link side answers itself (../../docs/design.md §4): the preview of a link (`/<key>+`) and
 * plain-text refusals. No script, no external resource; the page's only style is inline (the strict CSP allows
 * inline styles, never inline scripts), light and dark. Everything shown is escaped.
 */
import type { Resolvable } from './resolve.ts';
import type { RestProblem } from './targets.ts';

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text for HTML content and double-quoted attributes. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const STYLE =
  ':root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--line:#e7e5e4;--accent:#1d4ed8}' +
  '@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--accent:#93c5fd}}' +
  'body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}' +
  'main{max-width:40rem;margin:0 auto;padding:2rem 1rem}h1{font-size:1.25rem;margin:0 0 1rem}' +
  '.k{font:600 1.5rem ui-monospace,SFMono-Regular,Menlo,monospace;margin:0 0 .25rem}' +
  '.t{word-break:break-all;padding:.75rem;border:1px solid var(--line);border-radius:.5rem}' +
  'a{color:var(--accent)}.m{color:var(--muted);font-size:.875rem}';

/**
 * The preview page of a link: its key, where it goes for this request (or why it goes nowhere) and its
 * description. Shown to whoever may follow the link: anyone for a public link, the owner for a private one.
 */
export function previewPage(key: string, row: Resolvable, url: string | null): string {
  const where =
    url === null
      ? '<p class="t">This path does not lead anywhere: the link takes no path, or the path is not allowed.</p>'
      : `<p class="t"><a href="${escapeHtml(url)}" rel="noreferrer noopener">${escapeHtml(url)}</a></p>`;
  const description = row.description === '' ? '' : `<p>${escapeHtml(row.description)}</p>`;
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>s/${escapeHtml(key)}</title><style>${STYLE}</style></head>` +
    `<body><main><p class="k">s/${escapeHtml(key)}</p><h1>Goes to</h1>${where}${description}` +
    `<p class="m">${row.visibility === 'public' ? 'Public link' : 'Private link: only you can follow it.'}</p></main></body></html>`
  );
}

/** The plain-text answer when a link's path cannot reach its target. */
export function refusalText(problem: RestProblem): string {
  return problem === 'NO_PATH' ? 'This link takes no path after its key.\n' : 'This path is not allowed.\n';
}

export const NOT_FOUND_TEXT = 'Not found.\n';
export const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';
