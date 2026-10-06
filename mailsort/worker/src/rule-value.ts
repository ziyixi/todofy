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
