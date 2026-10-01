/**
 * The number NumberTrigger reads (../../../docs/design.md §5): the first number after the trigger's label, or the first
 * number of the text. Pure. Read from the extracted lines after the cleanup of stage 3 but before any mask, so
 * `mask_numbers` (noise in the diff) never hides the number the owner asked to watch.
 *
 * A number is an optional sign, digits with optional thousands separators (`1,299`, or a no-break or narrow no-break
 * space; never a plain space, which separates numbers), and an optional decimal part: `¥1,299.00` is 1299, `-3.5 %` is -3.5. A comma followed by exactly two digits
 * at the end (`12,50`) reads as a decimal comma.
 */

const NUMBER = /[-+−]?(?:\d{1,3}(?:[,\u00a0\u202f]\d{3})+|\d+)(?:[.,]\d+)?/u;

/** A number's text as a value, or null. */
export function parseNumber(text: string): number | null {
  let value = text.replace('−', '-').replace(/[\u00a0\u202f]/g, '');
  if (/^[-+]?\d+,\d{1,2}$/.test(value)) value = value.replace(',', '.');
  else value = value.replace(/,(?=\d{3}(?:\D|$))/g, '');
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** The first number in `text` after `label` (or anywhere when it is empty), as its text and value. */
export function findNumber(lines: readonly string[], label: string): { readonly text: string; readonly value: number } | null {
  const joined = lines.join('\n');
  let from = 0;
  if (label !== '') {
    const at = joined.toLowerCase().indexOf(label.toLowerCase());
    if (at < 0) return null;
    from = at + label.length;
  }
  const match = NUMBER.exec(joined.slice(from));
  if (match === null) return null;
  const value = parseNumber(match[0].trim());
  return value === null ? null : { text: match[0].trim(), value };
}

/** A number as the change's text (previous_value, current_value): shortest form, no exponent for usual sizes. */
export function numberText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}
