/**
 * Importing and exporting labels and rules (../../docs/design.md §6): the owner's rule file (a JSON list of rules,
 * the format of their own validated rule set), the export of this app (`{"labels": [...], "rules": [...]}`), and the
 * built-in template (template.ts).
 *
 * An import is planned first (planImport, pure over the store's rows): every entry is checked, matched with what
 * exists and marked create, update, skip or invalid, with the fields an update changes. The preview (validate_only)
 * answers that plan; the confirmation plans again and applies it in one transaction (applyImport), all or nothing,
 * and only when no entry is invalid. Nothing reaches Gmail: a new label is created there before its first write.
 *
 * Matching: a label by its path; a rule by its import ID (a re-import updates the rule it made), else by what it is
 * (kind, value, label and subject conditions). A label a rule names that exists nowhere is created enabled, not live
 * and without a description: rules decide it at once (in shadow first), the model only once the owner describes it.
 * Rule values pass rule-value.ts like every other rule's, since they reach Gmail filter criteria in the export.
 */
import { termsOf } from './decide.ts';
import { newEtag, shortId } from './ids.ts';
import {
  DESCRIPTION_MAX,
  IMPORT_ID_PATTERN,
  LABEL_ID_PATTERN,
  LABEL_PREFIX,
  LABELS_MAX,
  RULE_TEXT_MAX,
  RULES_MAX,
  SUBJECT_TERM_CHARS,
  SUBJECT_TERMS_MAX,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
} from './limits.ts';
import { labelIdFor, normalizePath, treeConflict } from './paths.ts';
import { ruleValueOk } from './rule-value.ts';
import type { LabelRow, RuleRow, Store } from './store.ts';
import { LABEL_TEMPLATE } from './template.ts';

/** A label entry as the request carries it (LabelImport). */
export interface LabelInput {
  readonly path: string;
  readonly description: string;
  readonly trust: boolean;
  readonly keepInInbox: boolean;
  readonly sensitive: boolean;
  readonly threshold: number;
}

/** A rule entry as the request carries it (RuleImport). */
export interface RuleInput {
  readonly id: string;
  readonly match: { readonly fromAddress: string; readonly fromDomain: string; readonly listId: string; readonly toAddress: string } | undefined;
  readonly label: string;
  readonly keepInInbox: boolean;
  readonly trust: boolean;
  readonly requireDmarc: boolean;
  readonly evidence: string;
  readonly notes: string;
  readonly subjectIncludes: readonly string[];
  readonly subjectExcludes: readonly string[];
}

export type Action = 'create' | 'update' | 'skip' | 'invalid';

/** A label's values as an import sets them. */
interface LabelValues {
  readonly path: string;
  readonly description: string;
  readonly trust: boolean;
  readonly keepInInbox: boolean;
  readonly sensitive: boolean;
  readonly threshold: number;
}

export interface PlannedLabel {
  readonly index: number;
  readonly action: Action;
  readonly key: string;
  /** The label's ID: the existing one, or the one a create gives it. */
  readonly id: string;
  readonly changed: readonly string[];
  readonly problem: string;
  readonly warning: string;
  /** Only a rule named it (created without a description). */
  readonly fromRule: boolean;
  readonly values: LabelValues;
}

interface RuleValues {
  readonly kind: RuleRow['kind'];
  readonly value: string;
  readonly labelPath: string;
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
  readonly keepInInbox: boolean;
  readonly requireDmarc: boolean;
  readonly evidence: string;
  readonly notes: string;
  readonly importId: string;
}

export interface PlannedRule {
  readonly index: number;
  readonly action: Action;
  readonly key: string;
  /** The rule's ID once known: the existing one, or the one a create gives it. */
  readonly id: string;
  readonly changed: readonly string[];
  readonly problem: string;
  readonly warning: string;
  readonly values: RuleValues | null;
}

export interface ImportPlan {
  readonly labels: readonly PlannedLabel[];
  readonly rules: readonly PlannedRule[];
}

/** Whether `text` has a control character (C0, DEL or C1). */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * A rule's subject words as stored: each trimmed, NFKC-folded and lower case (decide.ts foldSubject reads subjects the
 * same way), duplicates dropped; null when one is empty, too long or has a control character, or there are too many.
 */
export function foldTerms(raw: readonly string[]): string[] | null {
  if (raw.length > SUBJECT_TERMS_MAX) return null;
  const out: string[] = [];
  for (const item of raw) {
    const term = item.trim().normalize('NFKC').toLowerCase();
    if (term === '' || Array.from(term).length > SUBJECT_TERM_CHARS || hasControlChar(term)) return null;
    if (!out.includes(term)) out.push(term);
  }
  return out;
}

/** The path of a Gmail name of this app (`分拣/金融/投资`): 'label_prefix' without the prefix, 'label_path' when invalid. */
function pathOfName(name: string): { path: string } | { problem: string } {
  const trimmed = name.trim();
  if (!trimmed.startsWith(LABEL_PREFIX)) return { problem: 'label_prefix' };
  const path = normalizePath(trimmed.slice(LABEL_PREFIX.length));
  return path === null ? { problem: 'label_path' } : { path };
}

const KINDS = [
  ['fromAddress', 'sender_address'],
  ['fromDomain', 'sender_domain'],
  ['listId', 'list_id'],
  ['toAddress', 'delivered_to'],
] as const;

/** A rule's identity (what makes two rules the same rule: the table's unique key). */
function identity(kind: string, value: string, labelId: string, includes: readonly string[], excludes: readonly string[]): string {
  return JSON.stringify([kind, value, labelId, includes, excludes]);
}

/** The template's labels as import entries. */
export function templateLabels(): LabelInput[] {
  return LABEL_TEMPLATE.map((item) => ({ path: `${LABEL_PREFIX}${item.path}`, description: item.description, trust: item.trust, keepInInbox: item.keepInInbox, sensitive: item.sensitive, threshold: 0 }));
}

/** What the import would do (pure over the store's rows; nothing is written). */
export function planImport(store: Store, labelsIn: readonly LabelInput[], rulesIn: readonly RuleInput[]): ImportPlan {
  const existingLabels = store.labels();
  const byPath = new Map(existingLabels.map((row) => [row.display_name, row]));
  const takenIds = new Set(existingLabels.map((row) => row.id));
  const plannedLabels: PlannedLabel[] = [];
  const plannedByPath = new Map<string, PlannedLabel>();
  const invalidLabel = (index: number, key: string, problem: string): PlannedLabel => ({
    index,
    action: 'invalid',
    key,
    id: '',
    changed: [],
    problem,
    warning: '',
    fromRule: false,
    values: { path: key, description: '', trust: false, keepInInbox: false, sensitive: false, threshold: 0 },
  });

  // Labels of the request.
  labelsIn.forEach((input, index) => {
    const parsed = pathOfName(input.path);
    if ('problem' in parsed) {
      plannedLabels.push(invalidLabel(index, input.path, parsed.problem));
      return;
    }
    const { path } = parsed;
    const description = input.description.trim();
    if (Array.from(description).length > DESCRIPTION_MAX || hasControlChar(description.replace(/\n/g, ''))) {
      plannedLabels.push(invalidLabel(index, path, 'description'));
      return;
    }
    const threshold = input.threshold;
    if (threshold !== 0 && (!Number.isFinite(threshold) || threshold < THRESHOLD_MIN || threshold > THRESHOLD_MAX)) {
      plannedLabels.push(invalidLabel(index, path, 'threshold'));
      return;
    }
    if (plannedByPath.has(path)) {
      plannedLabels.push(invalidLabel(index, path, 'duplicate'));
      return;
    }
    const values: LabelValues = { path, description, trust: input.trust, keepInInbox: input.keepInInbox, sensitive: input.sensitive, threshold };
    const row = byPath.get(path);
    const planned = row === undefined ? createLabel(index, values, takenIds, false) : updateLabel(index, row, values);
    plannedLabels.push(planned);
    if (planned.action !== 'invalid') plannedByPath.set(path, planned);
  });

  // Rules, and the labels only they name.
  const existingRules = store.all<RuleRow>(`SELECT * FROM rules`);
  const byImportId = new Map(existingRules.filter((row) => row.import_id !== '').map((row) => [row.import_id, row]));
  const byIdentity = new Map(existingRules.map((row) => [identity(row.kind, row.value, row.label_id, termsOf(row.subject_includes), termsOf(row.subject_excludes)), row]));
  const takenRuleIds = new Set(existingRules.map((row) => row.id));
  const seenImportIds = new Set<string>();
  const seenIdentities = new Set<string>();
  const seenMatches = new Map<string, string>();
  const touchedRules = new Set<string>();
  const plannedRules: PlannedRule[] = [];
  const invalidRule = (index: number, key: string, problem: string): PlannedRule => ({ index, action: 'invalid', key, id: '', changed: [], problem, warning: '', values: null });

  rulesIn.forEach((input, index) => {
    const key = input.id;
    if (!IMPORT_ID_PATTERN.test(input.id)) return plannedRules.push(invalidRule(index, key, 'rule_id'));
    if (seenImportIds.has(input.id)) return plannedRules.push(invalidRule(index, key, 'duplicate'));
    seenImportIds.add(input.id);
    const set = KINDS.filter(([field]) => (input.match?.[field] ?? '') !== '');
    const chosen = set.length === 1 ? set[0] : undefined;
    if (chosen === undefined) return plannedRules.push(invalidRule(index, key, 'match'));
    const [field, kind] = chosen;
    const value = (input.match?.[field] ?? '').trim().toLowerCase();
    if (!ruleValueOk(kind, value)) return plannedRules.push(invalidRule(index, key, 'value'));
    const parsed = pathOfName(input.label);
    if ('problem' in parsed) return plannedRules.push(invalidRule(index, key, parsed.problem));
    const includes = foldTerms(input.subjectIncludes);
    const excludes = foldTerms(input.subjectExcludes);
    if (includes === null || excludes === null) return plannedRules.push(invalidRule(index, key, 'subject'));
    const evidence = input.evidence.trim();
    const notes = input.notes.trim();
    if ([evidence, notes].some((text) => Array.from(text).length > RULE_TEXT_MAX || hasControlChar(text))) return plannedRules.push(invalidRule(index, key, 'text'));

    // The label: planned from the request, existing, or created for this rule.
    const { path } = parsed;
    let label = plannedByPath.get(path);
    if (label === undefined) {
      const row = byPath.get(path);
      label =
        row !== undefined
          ? { index: -1, action: 'skip', key: path, id: row.id, changed: [], problem: '', warning: '', fromRule: true, values: { path, description: row.description, trust: row.trust === 1, keepInInbox: row.keep_in_inbox === 1, sensitive: row.sensitive === 1, threshold: row.threshold } }
          : createLabel(-1, { path, description: '', trust: input.trust, keepInInbox: false, sensitive: false, threshold: 0 }, takenIds, true);
      plannedByPath.set(path, label);
      if (row === undefined) plannedLabels.push(label);
    } else if (label.fromRule && label.action === 'create' && input.trust && !label.values.trust) {
      // A label only rules name is a trust label when any of its rules says so.
      const trusted: PlannedLabel = { ...label, values: { ...label.values, trust: true } };
      plannedByPath.set(path, trusted);
      plannedLabels[plannedLabels.indexOf(label)] = trusted;
      label = trusted;
    }
    const values: RuleValues = { kind, value, labelPath: path, includes, excludes, keepInInbox: input.keepInInbox, requireDmarc: input.requireDmarc, evidence, notes, importId: input.id };
    const id = identity(kind, value, label.id, includes, excludes);
    if (seenIdentities.has(id)) return plannedRules.push(invalidRule(index, key, 'duplicate'));
    seenIdentities.add(id);
    const matchKey = JSON.stringify([kind, value, includes, excludes]);
    const warnings: string[] = [];
    if (input.trust && !label.values.trust) warnings.push('trust_mismatch');
    if (seenMatches.has(matchKey) && seenMatches.get(matchKey) !== path) warnings.push('same_match');
    seenMatches.set(matchKey, path);

    const existing = byImportId.get(input.id) ?? byIdentity.get(id);
    // Two entries of one import that both mean the same existing rule: the second is a duplicate.
    if (existing !== undefined && touchedRules.has(existing.id)) return plannedRules.push(invalidRule(index, key, 'duplicate'));
    if (existing === undefined) {
      const ruleId = LABEL_ID_PATTERN.test(input.id) && !takenRuleIds.has(input.id) ? input.id : '';
      if (ruleId !== '') takenRuleIds.add(ruleId);
      plannedRules.push({ index, action: 'create', key, id: ruleId, changed: [], problem: '', warning: warnings[0] ?? '', values });
      return;
    }
    // The same rule under another identity would break the table's unique key.
    const clash = byIdentity.get(id);
    if (clash !== undefined && clash.id !== existing.id) return plannedRules.push(invalidRule(index, key, 'duplicate'));
    touchedRules.add(existing.id);
    const changed: string[] = [];
    if (existing.kind !== kind || existing.value !== value) changed.push('match');
    if (existing.label_id !== label.id) changed.push('label');
    if (JSON.stringify(termsOf(existing.subject_includes)) !== JSON.stringify(includes)) changed.push('subject_includes');
    if (JSON.stringify(termsOf(existing.subject_excludes)) !== JSON.stringify(excludes)) changed.push('subject_excludes');
    if ((existing.keep_in_inbox === 1) !== input.keepInInbox) changed.push('keep_in_inbox');
    if ((existing.require_dmarc === 1) !== input.requireDmarc) changed.push('require_dmarc');
    if (existing.evidence !== evidence) changed.push('evidence');
    if (existing.notes !== notes) changed.push('notes');
    if (existing.import_id !== input.id) changed.push('import_id');
    // Importing a proposed rule is the owner's approval of it; a rule the owner disabled stays disabled.
    if (existing.state === 'proposed') changed.push('state');
    if (existing.state === 'disabled') warnings.push('rule_disabled');
    plannedRules.push({ index, action: changed.length === 0 ? 'skip' : 'update', key, id: existing.id, changed, problem: '', warning: warnings[0] ?? '', values });
  });

  // The tree (only leaves are labels) and the bounds, over the labels as they would be.
  const finalPaths = new Set([...existingLabels.map((row) => row.display_name), ...plannedLabels.filter((item) => item.action === 'create').map((item) => item.values.path)]);
  let labelCount = existingLabels.length;
  const checkedLabels = plannedLabels.map((item): PlannedLabel => {
    if (item.action !== 'create') return item;
    if (treeConflict(item.values.path, finalPaths) !== null) return { ...item, action: 'invalid', problem: 'label_tree' };
    labelCount += 1;
    return labelCount > LABELS_MAX ? { ...item, action: 'invalid', problem: 'labels_full' } : item;
  });
  let ruleCount = existingRules.length;
  const checkedRules = plannedRules.map((item): PlannedRule => {
    if (item.action !== 'create') return item;
    ruleCount += 1;
    return ruleCount > RULES_MAX ? { ...item, action: 'invalid', problem: 'rules_full' } : item;
  });
  return { labels: checkedLabels, rules: checkedRules };
}

function createLabel(index: number, values: LabelValues, takenIds: Set<string>, fromRule: boolean): PlannedLabel {
  const id = labelIdFor(values.path, takenIds);
  if (id === null) return { index, action: 'invalid', key: values.path, id: '', changed: [], problem: 'label_path', warning: '', fromRule, values };
  takenIds.add(id);
  return { index, action: 'create', key: values.path, id, changed: [], problem: '', warning: '', fromRule, values };
}

function updateLabel(index: number, row: LabelRow, values: LabelValues): PlannedLabel {
  const changed: string[] = [];
  if (row.description !== values.description) changed.push('description');
  if ((row.trust === 1) !== values.trust) changed.push('trust');
  if ((row.keep_in_inbox === 1) !== values.keepInInbox) changed.push('keep_in_inbox');
  if ((row.sensitive === 1) !== values.sensitive) changed.push('sensitive');
  if (row.threshold !== values.threshold) changed.push('threshold');
  return { index, action: changed.length === 0 ? 'skip' : 'update', key: values.path, id: row.id, changed, problem: '', warning: '', fromRule: false, values };
}

/** Whether the plan may be applied: no entry is invalid. */
export function planValid(plan: ImportPlan): boolean {
  return [...plan.labels, ...plan.rules].every((item) => item.action !== 'invalid');
}

/**
 * Applies a valid plan (planImport, just now, in the same transaction): creates and updates the labels, then the
 * rules. Answers the plan with the rule IDs creates got. Run inside a transaction.
 */
export function applyImport(store: Store, plan: ImportPlan, now: number): ImportPlan {
  for (const item of plan.labels) {
    const v = item.values;
    if (item.action === 'create') {
      const seq = (store.one<{ seq: number | null }>(`SELECT max(seq) AS seq FROM labels`)?.seq ?? 0) + 1;
      store.run(
        `INSERT INTO labels (id, seq, display_name, description, enabled, live, trust, threshold, gmail_state, desc_version, live_since, create_time, update_time, etag, keep_in_inbox, sensitive)
         VALUES (?, ?, ?, ?, 1, 0, ?, ?, 'pending', 1, NULL, ?, ?, ?, ?, ?)`,
        item.id,
        seq,
        v.path,
        v.description,
        v.trust ? 1 : 0,
        v.threshold,
        now,
        now,
        newEtag(now),
        v.keepInInbox ? 1 : 0,
        v.sensitive ? 1 : 0,
      );
    } else if (item.action === 'update') {
      store.run(
        `UPDATE labels SET description = ?, trust = ?, keep_in_inbox = ?, sensitive = ?, threshold = ?, desc_version = desc_version + ?, update_time = ?, etag = ? WHERE id = ?`,
        v.description,
        v.trust ? 1 : 0,
        v.keepInInbox ? 1 : 0,
        v.sensitive ? 1 : 0,
        v.threshold,
        item.changed.includes('description') ? 1 : 0,
        now,
        newEtag(now),
        item.id,
      );
    }
  }
  const labelIds = new Map(store.labels().map((row) => [row.display_name, row.id]));
  const rules = plan.rules.map((item, order): PlannedRule => {
    const v = item.values;
    if (v === null || (item.action !== 'create' && item.action !== 'update')) return item;
    const labelId = labelIds.get(v.labelPath) ?? '';
    const includes = JSON.stringify(v.includes);
    const excludes = JSON.stringify(v.excludes);
    if (item.action === 'create') {
      const id = item.id !== '' ? item.id : shortId('r');
      // The file's order breaks ties between rules of the same rank (decide.ts orderRules reads create_time).
      store.run(
        `INSERT INTO rules (id, kind, value, label_id, state, create_time, update_time, subject_includes, subject_excludes, keep_in_inbox, require_dmarc, evidence, notes, import_id)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        v.kind,
        v.value,
        labelId,
        now + order,
        now,
        includes,
        excludes,
        v.keepInInbox ? 1 : 0,
        v.requireDmarc ? 1 : 0,
        v.evidence,
        v.notes,
        v.importId,
      );
      return { ...item, id };
    }
    store.run(
      `UPDATE rules SET kind = ?, value = ?, label_id = ?, subject_includes = ?, subject_excludes = ?, keep_in_inbox = ?, require_dmarc = ?, evidence = ?, notes = ?, import_id = ?,
         state = CASE state WHEN 'proposed' THEN 'active' ELSE state END, update_time = ? WHERE id = ?`,
      v.kind,
      v.value,
      labelId,
      includes,
      excludes,
      v.keepInInbox ? 1 : 0,
      v.requireDmarc ? 1 : 0,
      v.evidence,
      v.notes,
      v.importId,
      now,
      item.id,
    );
    return item;
  });
  return { labels: plan.labels, rules };
}

const MATCH_FIELDS: Readonly<Record<RuleRow['kind'], string>> = { sender_address: 'from_address', sender_domain: 'from_domain', list_id: 'list_id', delivered_to: 'to_address' };

/**
 * Every label and every rule but the proposals, as the JSON document an import reads back: the rules in the owner's
 * rule file format (`trust` is the label's), subject conditions only where a rule has them.
 */
export function exportDocument(store: Store): { json: string; labels: number; rules: number } {
  const labels = store.labels();
  const pathOf = new Map(labels.map((row) => [row.id, row]));
  const rules = store.all<RuleRow>(`SELECT * FROM rules WHERE state != 'proposed' ORDER BY create_time, id`).filter((row) => pathOf.has(row.label_id));
  const document = {
    labels: labels.map((row) => ({
      path: `${LABEL_PREFIX}${row.display_name}`,
      description: row.description,
      trust: row.trust === 1,
      keep_in_inbox: row.keep_in_inbox === 1,
      sensitive: row.sensitive === 1,
      threshold: row.threshold,
    })),
    rules: rules.map((row) => {
      const label = pathOf.get(row.label_id);
      const includes = termsOf(row.subject_includes);
      const excludes = termsOf(row.subject_excludes);
      return {
        id: row.import_id !== '' ? row.import_id : row.id,
        match: { [MATCH_FIELDS[row.kind]]: row.value },
        label: `${LABEL_PREFIX}${label?.display_name ?? ''}`,
        keep_in_inbox: row.keep_in_inbox === 1,
        trust: label?.trust === 1,
        require_dmarc: row.require_dmarc === 1,
        evidence: row.evidence,
        notes: row.notes,
        ...(includes.length > 0 ? { subject_includes: includes } : {}),
        ...(excludes.length > 0 ? { subject_excludes: excludes } : {}),
      };
    }),
  };
  return { json: `${JSON.stringify(document, null, 2)}\n`, labels: document.labels.length, rules: document.rules.length };
}
