/**
 * What a rule's value may be (../../docs/design.md §6.3), for every way a rule comes in: the owner's CreateRule, a
 * proposal from corrections (values taken from mail headers, so untrusted), and the Gmail filter export. The export
 * puts the value into Gmail search criteria, where `(`, `)`, `-`, `{`, `*`, `OR`, quotes or spaces could widen one
 * sender's filter to most incoming mail. So a value is plain characters only, never starts with `-`, and the export
 * quotes it as well.
 */
import type { RuleRow } from './store.ts';

/** A domain: dot-separated labels of letters, digits and inner dashes, no label starting with `-`. */
const DOMAIN = /^(?=.{3,200}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;
/** An address: a plain local part (no leading `-`) and a domain. */
const ADDRESS = /^(?=.{3,200}$)(?!-)[a-z0-9._%+-]{1,64}@(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;
/** A List-Id: its identifier (RFC 2919), lower case, plain characters. */
const LIST_ID = /^[a-z0-9][a-z0-9._-]{2,199}$/;

/** Whether `value` (lower case, trimmed) is a valid value of a rule of `kind`. */
export function ruleValueOk(kind: RuleRow['kind'], value: string): boolean {
  switch (kind) {
    case 'sender_domain':
      return DOMAIN.test(value);
    case 'list_id':
      return LIST_ID.test(value);
    case 'sender_address':
    case 'delivered_to':
      return ADDRESS.test(value);
  }
}

/**
 * A rule value as the owner or a file writes it, in the form ruleValueOk checks: trimmed and lower case, and for a
 * List-Id also without the angle brackets of its header form (`<digest.news.example.com>`, as copied from a mail's
 * List-Id header). Every entry point (CreateRule, an import) reads values through this, so they agree.
 */
export function normalizeRuleValue(kind: RuleRow['kind'], raw: string): string {
  const value = raw.trim().toLowerCase();
  if (kind === 'list_id' && value.startsWith('<') && value.endsWith('>')) return value.slice(1, -1).trim();
  return value;
}

/** A C0 or C1 control character, DEL included. */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * The owner's evidence or notes of a rule as stored, or null when not acceptable: line breaks are allowed (a validated
 * rule file often has multi-line evidence; CRLF and CR become LF), every other control character is refused, at most
 * `max` characters after trimming. Label descriptions accept line breaks the same way.
 */
export function ruleText(raw: string, max: number): string | null {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (Array.from(text).length > max) return null;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 0x0a && isControl(code)) return null;
  }
  return text;
}
