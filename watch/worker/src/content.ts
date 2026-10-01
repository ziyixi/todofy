/**
 * Stage 3 applied to a page (../../docs/design.md §5): the compared form of what a source yielded, the Content that
 * snapshots keep, diffs compare and triggers read. Pure (but for the hash).
 *
 * - lines: the normalized lines (normalize.ts: NFKC, zero-width, whitespace, the default masks);
 * - keys: what NewItemTrigger compares: the items' keys (feeds, JSON), else the normalized lines;
 * - number: NumberTrigger's number, read from the cleaned but unmasked lines (null when the trigger is another);
 * - availability: the first offer's schema.org availability (JSON-LD), or null.
 *
 * A trigger that needs a value the page does not have fails the health gate (VALUE_MISSING) here.
 *
 * The owner's ignored lines (NormalizeOptions.ignored_lines, the drawer's "忽略这一行") are not applied here: a
 * snapshot keeps every line, and `viewOf` drops the ignored ones from both sides whenever texts are compared. So
 * ignoring a line, or taking it back, never moves the notified state (the edit is not a change of what is read) and
 * never shows the line as a change of its own.
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

/** Stage 3 of a raw page for a watch's normalize options and trigger (the ignored lines kept: see `viewOf`). */
export function buildContent(raw: RawPage, normalize: NormalizeConfig, trigger: TriggerConfig): Built {
  const options = { ignoredLines: [], defaultMasks: normalize.defaultMasks, maskNumbers: normalize.maskNumbers };
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
  return { ok: true, content: { lines: normalized.lines, keys, number, availability: raw.availability }, masked: normalized.masked, ignored: 0 };
}

/**
 * A text as compared: without the owner's ignored lines (exact normalized lines), and without keys equal to one when
 * the keys are the lines (a page's). `ignored` counts the lines dropped.
 */
export function viewOf(content: Content, ignoredLines: readonly string[]): { readonly content: Content; readonly ignored: number } {
  if (ignoredLines.length === 0) return { content, ignored: 0 };
  const ignored = new Set(ignoredLines);
  const lines = content.lines.filter((line) => !ignored.has(line));
  if (lines.length === content.lines.length) return { content, ignored: 0 };
  const keysAreLines = content.keys.length === content.lines.length && content.keys.every((key, index) => key === content.lines[index]);
  return { content: { ...content, lines, keys: keysAreLines ? lines : content.keys }, ignored: content.lines.length - lines.length };
}

/** The hash a check compares (the "seen" and notified states). */
export function contentSha(content: Content): Promise<string> {
  return sha256Hex(JSON.stringify([content.lines, content.keys, content.number, content.availability]));
}
