/**
 * Stage 3 applied to a page (../../docs/design.md §5): the compared form of what a source yielded, the Content that
 * snapshots keep, diffs compare and triggers read. Pure (but for the hash).
 *
 * - lines: the normalized lines (normalize.ts: NFKC, zero-width, whitespace, the default masks, ignored lines);
 * - keys: what NewItemTrigger compares: the items' keys (feeds, JSON), else the normalized lines;
 * - number: NumberTrigger's number, read from the cleaned but unmasked lines (null when the trigger is another);
 * - availability: the first offer's schema.org availability (JSON-LD), or null.
 *
 * A trigger that needs a value the page does not have fails the health gate (VALUE_MISSING) here.
 */
import { sha256Hex, type NormalizeConfig, type TriggerConfig } from './config.ts';
import type { RawPage } from './extract/index.ts';
import { findNumber, numberText } from './extract/number.ts';
import { cleanLine, maskLine, normalizeLines } from './normalize.ts';

export interface Content {
  readonly lines: readonly string[];
  readonly keys: readonly string[];
  readonly number: string | null;
  readonly availability: string | null;
}

export type Built = { readonly ok: true; readonly content: Content; readonly masked: number; readonly ignored: number } | { readonly ok: false; readonly failure: 'VALUE_MISSING' };

/** Stage 3 of a raw page for a watch's normalize options and trigger. */
export function buildContent(raw: RawPage, normalize: NormalizeConfig, trigger: TriggerConfig): Built {
  const options = { ignoredLines: normalize.ignoredLines, defaultMasks: normalize.defaultMasks, maskNumbers: normalize.maskNumbers };
  const normalized = normalizeLines(raw.lines, options);
  let number: string | null = null;
  if (trigger.kind === 'number') {
    const found = findNumber(raw.lines.map(cleanLine), trigger.label);
    if (found === null) return { ok: false, failure: 'VALUE_MISSING' };
    number = numberText(found.value);
  }
  if (trigger.kind === 'availability' && raw.availability === null) return { ok: false, failure: 'VALUE_MISSING' };
  const keys =
    raw.items === null
      ? normalized.lines
      : raw.items.map((item) => maskLine(cleanLine(item.key), false, normalize.defaultMasks).text).filter((key) => key !== '');
  return { ok: true, content: { lines: normalized.lines, keys, number, availability: raw.availability }, masked: normalized.masked, ignored: normalized.ignored };
}

/** The hash a check compares (the "seen" and notified states). */
export function contentSha(content: Content): Promise<string> {
  return sha256Hex(JSON.stringify([content.lines, content.keys, content.number, content.availability]));
}
