/**
 * The active rules as a Gmail filter file (../../docs/design.md §6.3): the Atom XML that Gmail's Settings > Filters >
 * Import filters reads, for the owner to import by hand, so the stable rules keep working without this app. Each
 * filter adds the label and archives, like mailsort's own writes; none marks read, stars, forwards or deletes. Rules
 * that need DMARC are left out (a filter cannot check it), and so is any value rule-value.ts refuses.
 */
import { LABEL_PREFIX } from './limits.ts';
import { ruleValueOk } from './rule-value.ts';
import type { RuleRow } from './store.ts';

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

export function gmailFilterXml(rules: readonly (Pick<RuleRow, 'kind' | 'value'> & { readonly labelName: string })[], now: number): string {
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
      "<apps:property name='shouldArchive' value='true'/>",
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
