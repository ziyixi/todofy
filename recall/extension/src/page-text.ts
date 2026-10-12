/**
 * What the capture script reads from a page (../../docs/design.md §3.4), in the page's isolated world: where the
 * document is now (an SPA may have moved to another route since the capture was claimed), the title, the meta
 * description, `document.body.innerText` cut to 64 KiB of UTF-8 at a character boundary, and whether a visible password
 * field is on the page (then no text is read at all). No HTML is read. The service worker scrubs it all.
 */
import { cutUtf8, DOCUMENT_MAX_BYTES } from '../../shared/url.ts';

export interface PageText {
  /** The build of the script that read it: the service worker drops a result of another build. */
  readonly build: string;
  readonly documentId?: string;
  readonly visible?: boolean;
  /** The document's URL when it was read (location.href). */
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly text: string;
  readonly textTruncated: boolean;
  readonly hasPasswordField: boolean;
}

export function readPage(doc: Document, build: string): PageText {
  const hasPasswordField = Array.from(doc.querySelectorAll('input[type="password" i]')).some((field) => typeof field.checkVisibility === 'function' ? field.checkVisibility() : field.getClientRects().length > 0);
  const description = doc.querySelector('meta[name="description" i]')?.getAttribute('content') ?? '';
  // A document without a body (an XML document, a frameset) has no text.
  const body = doc.querySelector('body');
  const text = hasPasswordField ? { text: '', truncated: false } : cutUtf8(body?.innerText ?? '', DOCUMENT_MAX_BYTES);
  const probe = globalThis.recallPageProbe;
  return { build, ...(probe === undefined ? {} : { documentId: probe.documentId, visible: probe.visible && doc.visibilityState === 'visible' }), url: doc.location.href, title: doc.title, description, text: text.text, textTruncated: text.truncated, hasPasswordField };
}

/** Whether a value is a PageText (an executeScript result is whatever the page's world left). */
export function isPageText(value: unknown): value is PageText {
  if (typeof value !== 'object' || value === null) return false;
  const text = value as Record<string, unknown>;
  return (
    typeof text['build'] === 'string' &&
    typeof text['url'] === 'string' &&
    typeof text['title'] === 'string' &&
    typeof text['description'] === 'string' &&
    typeof text['text'] === 'string' &&
    typeof text['textTruncated'] === 'boolean' &&
    typeof text['hasPasswordField'] === 'boolean'
  );
}
