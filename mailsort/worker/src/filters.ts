/**
 * The active rules as a Gmail filter file (../../docs/design.md §6.3): the Atom XML that Gmail's Settings > Filters >
 * Import filters reads, for the owner to import by hand, so the stable rules keep working without this app. Each
 * filter adds the label and archives (or only labels, for a rule or label that keeps its mail in the inbox), like
 * mailsort's own writes; none marks read, stars, forwards or deletes. Which rules are left out is the API's choice
 * (api.ts exportGmailFilters); any value rule-value.ts refuses is left out here too.
 */
import { termsOf } from './decide.ts';
import { LABEL_PREFIX } from './limits.ts';
import { ruleValueOk } from './rule-value.ts';
import type { RuleRow } from './store.ts';

/** What the export needs of an active rule and its label. */
export type ExportCandidate = Pick<RuleRow, 'id' | 'kind' | 'value' | 'require_dmarc' | 'subject_includes' | 'subject_excludes'> & { readonly trust: number };

function hasSubjectConditions(rule: Pick<RuleRow, 'subject_includes' | 'subject_excludes'>): boolean {
  return termsOf(rule.subject_includes).length > 0 || termsOf(rule.subject_excludes).length > 0;
}

/** The sender domain a sender rule covers (an address's domain), or null for a list or delivered-to rule. */
function senderDomainOf(rule: Pick<RuleRow, 'kind' | 'value'>): string | null {
  if (rule.kind === 'sender_domain') return rule.value;
  if (rule.kind === 'sender_address') return rule.value.slice(rule.value.lastIndexOf('@') + 1);
  return null;
}

/** Whether `domain` is `parent` or one of its subdomains (Gmail's `from:"parent"` matches both). */
function withinDomain(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/**
 * Whether two rules can match the same mail by their sender keys: the same kind and value, or two sender rules whose
 * addresses and domains overlap (a domain rule and an address or a subdomain under it, either way round). Erring
 * towards "overlaps" only ever leaves a filter out, which is the safe direction.
 */
function overlaps(a: Pick<RuleRow, 'kind' | 'value'>, b: Pick<RuleRow, 'kind' | 'value'>): boolean {
  if (a.kind === b.kind && a.value === b.value) return true;
  const da = senderDomainOf(a);
  const db = senderDomainOf(b);
  if (da === null || db === null) return false;
  if (a.kind === 'sender_address' && b.kind === 'sender_address') return false; // two different addresses
  if (a.kind === 'sender_domain' && b.kind === 'sender_domain') return withinDomain(da, db) || withinDomain(db, da);
  // One address and one domain: the address's domain under the domain rule's.
  return a.kind === 'sender_domain' ? withinDomain(db, da) : withinDomain(da, db);
}

/**
 * Which active rules become Gmail filters (design §6). Left out:
 * - a rule of a trust label, or with its own DMARC switch: a filter cannot check DMARC, and a forged From could then
 *   reach a trust label;
 * - a rule with subject conditions: Gmail applies every matching filter, so a carve-out and the sender's plain rule
 *   would both label the mail;
 * - a plain rule whose sender an active subject-conditioned rule covers (same kind and value, or a domain that covers
 *   the carved address or subdomain, either way round). Exported alone it would give the carved-out mail (a pickup
 *   code meant to stay in the inbox, a login notice meant for 账号安全) the sender's plain label and archive it in Gmail:
 *   the opposite of what the owner asked for. Without the filter Gmail does nothing to that sender's mail, which only
 *   leaves it in the inbox;
 * - a value rule-value.ts refuses (an older row).
 */
export function exportableRules<T extends ExportCandidate>(rules: readonly T[]): { exported: T[]; skipped: number } {
  const conditioned = rules.filter(hasSubjectConditions);
  const exported = rules.filter(
    (rule) =>
      rule.trust === 0 &&
      rule.require_dmarc === 0 &&
      !hasSubjectConditions(rule) &&
      !conditioned.some((carve) => overlaps(carve, rule)) &&
      ruleValueOk(rule.kind, rule.value),
  );
  return { exported, skipped: rules.length - exported.length };
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char] ?? char);
}

/**
 * The Gmail search property of a rule: `from`, or `hasTheWord` with an operator. The caller exports only values
 * rule-value.ts accepts; the value is quoted as well, so Gmail reads it as one exact term.
 */
function criterion(rule: Pick<RuleRow, 'kind' | 'value'>): [string, string] {
  const quoted = `"${rule.value}"`;
  switch (rule.kind) {
    case 'sender_address':
    case 'sender_domain':
      return ['from', quoted];
    case 'list_id':
      return ['hasTheWord', `list:(${quoted})`];
    case 'delivered_to':
      return ['hasTheWord', `deliveredto:(${quoted})`];
  }
}

export function gmailFilterXml(rules: readonly (Pick<RuleRow, 'kind' | 'value'> & { readonly labelName: string; readonly archive?: boolean })[], now: number): string {
  const updated = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  // Checked here too, so the file is safe whoever calls this (the API also counts what it left out).
  const entries = rules.filter((rule) => ruleValueOk(rule.kind, rule.value)).map((rule) => {
    const [name, value] = criterion(rule);
    return [
      '<entry>',
      "<category term='filter'></category>",
      '<title>Mail Filter</title>',
      `<updated>${updated}</updated>`,
      '<content></content>',
      `<apps:property name='${name}' value='${escapeXml(value)}'/>`,
      `<apps:property name='label' value='${escapeXml(`${LABEL_PREFIX}${rule.labelName}`)}'/>`,
      // A rule or label that keeps its mail in the inbox: the filter only labels.
      ...(rule.archive === false ? [] : ["<apps:property name='shouldArchive' value='true'/>"]),
      "<apps:property name='sizeOperator' value='s_sl'/>",
      "<apps:property name='sizeUnit' value='s_smb'/>",
      '</entry>',
    ].join('');
  });
  return [
    "<?xml version='1.0' encoding='UTF-8'?>",
    "<feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'>",
    '<title>Mail Filters</title>',
    `<updated>${updated}</updated>`,
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}
