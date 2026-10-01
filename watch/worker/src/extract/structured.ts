/**
 * Fetch tier 0, structured sources (../../../docs/design.md §4): data a page or an API publishes as data, read before any
 * text. Pure functions over already decoded text:
 *
 * - JSON (JsonSource): the values at a path (jsonpath.ts), one line and one item each;
 * - JSON-LD (EmbeddedSource KIND_JSON_LD): every `<script type="application/ld+json">` block, `@graph` flattened;
 *   without a path one line per schema.org Product or Offer (name, price and currency, availability);
 * - Next.js page data (KIND_NEXT_DATA): the JSON of `<script id="__NEXT_DATA__">`, with a path.
 *
 * The schema.org availability of the first offer is what AvailabilityTrigger reads, as its short name (`InStock`).
 */
import { ITEMS_MAX, LINE_MAX } from '../limits.ts';
import { evaluatePath, parsePath, valueKey, valueLine } from './jsonpath.ts';

export interface Item {
  readonly key: string;
  readonly text: string;
}

export interface Structured {
  readonly lines: string[];
  readonly items: Item[];
  /** The schema.org availability of the first offer (`InStock`), or null. */
  readonly availability: string | null;
}

/** The availabilities a buyer can act on (AvailabilityTrigger.only_when_available). */
export const AVAILABLE = new Set(['InStock', 'LimitedAvailability', 'OnlineOnly', 'InStoreOnly', 'PreOrder', 'PreSale', 'BackOrder']);

/** JSON text, or undefined when it does not parse (a block wrapped in HTML comments or CDATA is unwrapped first). */
export function parseJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^<!--|-->$/g, '')
    .replace(/^\s*\/\/\s*<!\[CDATA\[|\/\/\s*\]\]>\s*$/g, '')
    .trim();
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    return undefined;
  }
}

/** The values at `path` of a JSON document as lines and items; null when the path is not valid. */
export function jsonValues(document: unknown, path: string): Structured | null {
  const steps = parsePath(path);
  if (steps === null) return null;
  const values = evaluatePath(document, steps);
  // Without a step that fans out, a single array is read as its elements (a list API's answer).
  const spread = values.length === 1 && Array.isArray(values[0]) ? (values[0] as unknown[]).slice(0, ITEMS_MAX) : values;
  const items = spread.map((value) => ({ key: valueKey(value), text: valueLine(value) }));
  return { lines: items.map((item) => item.text), items, availability: null };
}

/** Every schema.org node of JSON-LD blocks: arrays and `@graph` flattened, at most ITEMS_MAX. */
export function jsonLdNodes(blocks: readonly unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number) => {
    if (out.length >= ITEMS_MAX || depth > 4) return;
    if (Array.isArray(value)) {
      for (const element of value) visit(element, depth + 1);
    } else if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      if (Array.isArray(record['@graph'])) visit(record['@graph'], depth + 1);
      if (record['@type'] !== undefined) out.push(record);
    }
  };
  for (const block of blocks) visit(block, 0);
  return out;
}

function types(node: Record<string, unknown>): string[] {
  const type = node['@type'];
  return (Array.isArray(type) ? type : [type]).filter((name): name is string => typeof name === 'string');
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** A schema.org ItemAvailability as its short name (`https://schema.org/InStock` is `InStock`). */
export function availabilityName(value: unknown): string {
  const raw = text(value);
  return raw.replace(/^https?:\/\/schema\.org\//i, '').replace(/^schema:/i, '');
}

function offersOf(node: Record<string, unknown>): Record<string, unknown>[] {
  const offers = node['offers'];
  const list = Array.isArray(offers) ? offers : offers === undefined ? [] : [offers];
  const out: Record<string, unknown>[] = [];
  for (const offer of list) {
    if (typeof offer !== 'object' || offer === null) continue;
    const record = offer as Record<string, unknown>;
    // An AggregateOffer lists its offers again, or gives a low and high price.
    if (Array.isArray(record['offers'])) out.push(...offersOf(record));
    else out.push(record);
  }
  return out;
}

function offerLine(name: string, offer: Record<string, unknown>): string {
  const price = text(offer['price'] ?? offer['lowPrice']);
  const currency = text(offer['priceCurrency']);
  const availability = availabilityName(offer['availability']);
  const parts = [name === '' ? '(商品)' : name];
  if (price !== '') parts.push(currency === '' ? price : `${price} ${currency}`);
  if (availability !== '') parts.push(availability);
  return parts.join(' — ').slice(0, LINE_MAX);
}

/** The products and offers of JSON-LD blocks as lines (one per offer), and the first offer's availability. */
export function jsonLdProducts(blocks: readonly unknown[]): Structured {
  const lines: string[] = [];
  const items: Item[] = [];
  let availability: string | null = null;
  for (const node of jsonLdNodes(blocks)) {
    const kinds = types(node);
    const isProduct = kinds.some((kind) => kind === 'Product' || kind === 'ProductGroup' || kind === 'IndividualProduct');
    const isOffer = kinds.some((kind) => kind === 'Offer' || kind === 'AggregateOffer');
    if (!isProduct && !isOffer) continue;
    const name = text(node['name']);
    const offers = isOffer ? [node] : offersOf(node);
    if (offers.length === 0 && isProduct) {
      const line = offerLine(name, {});
      lines.push(line);
      items.push({ key: text(node['sku']) || text(node['@id']) || line, text: line });
    }
    for (const offer of offers) {
      const line = offerLine(name, offer);
      lines.push(line);
      items.push({ key: text(offer['sku']) || text(offer['url']) || text(node['sku']) || line, text: line });
      const found = availabilityName(offer['availability']);
      if (availability === null && found !== '') availability = found;
    }
    if (lines.length >= ITEMS_MAX) break;
  }
  return { lines: lines.slice(0, ITEMS_MAX), items: items.slice(0, ITEMS_MAX), availability };
}

/** JSON-LD blocks read through `path` (each block is a document), or the products without one. */
export function readJsonLd(texts: readonly string[], path: string): Structured | null {
  const blocks = texts.map(parseJson).filter((block) => block !== undefined);
  if (blocks.length === 0) return null;
  const products = jsonLdProducts(blocks);
  if (path === '' || path === '$') return products;
  const steps = parsePath(path);
  if (steps === null) return null;
  const values = blocks.flatMap((block) => evaluatePath(block, steps)).slice(0, ITEMS_MAX);
  const items = values.map((value) => ({ key: valueKey(value), text: valueLine(value) }));
  return { lines: items.map((item) => item.text), items, availability: products.availability };
}
