import { addDays, validDate } from '@ziyixi/task-dates';
import { invalid } from './errors.ts';
export interface SqlFilter {
  sql: string;
  values: (string | number)[];
}

/** Small parser for the owner's existing Todoist filter vocabulary; no eval and all values are bound. */
export function taskFilter(query: string, today: string): SqlFilter {
  if (query.length > 1000) invalid('Filter is too long');
  const tokens =
    query
      .match(/[()&|,!]|[^()&|,!]+/g)
      ?.map((token) => token.trim())
      .filter(Boolean) ?? [];
  if (!tokens.length) return { sql: '1', values: [] };
  if (tokens.length > 120) invalid('Filter has too many terms');
  let position = 0;
  let depth = 0;
  const values: (string | number)[] = [];
  const bound = (value: string | number) => {
    values.push(value);
    return '?';
  };
  function dateTerm(value: string): string {
    if (validDate(value)) return value;
    if (value === 'today') return today;
    if (value === 'yesterday') return addDays(today, -1);
    if (value === 'tomorrow') return addDays(today, 1);
    const relative = /^in (\d{1,3}) days?$/.exec(value);
    if (relative) return addDays(today, Number(relative[1]));
    invalid('Unsupported relative date in filter');
  }
  function atom(text: string): string {
    if (text.startsWith('@'))
      return `EXISTS(SELECT 1 FROM task_labels tl JOIN labels l ON l.id=tl.label_id WHERE tl.task_id=t.id AND l.deleted_at IS NULL AND l.title=${bound(text.slice(1))} COLLATE NOCASE)`;
    if (text.startsWith('#'))
      return `EXISTS(SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.deleted_at IS NULL AND p.title=${bound(text.slice(1))} COLLATE NOCASE)`;
    const lower = text.toLowerCase();
    if (lower === 'all') return '1';
    if (lower === 'subtask') return "t.parent_id<>''";
    if (lower === 'no date') return "t.due_date=''";
    if (lower === 'no deadline') return "t.deadline=''";
    if (lower === 'today') return `t.due_date=${bound(today)}`;
    if (lower === 'overdue') return `(t.due_date<>'' AND t.due_date<${bound(today)})`;
    if (/^p[1-4]$/.test(lower)) return `t.priority=${bound(Number(lower[1]))}`;
    const comparison = /^(deadline|due)(?: (before|after))?:\s*(.+)$/.exec(lower);
    if (comparison) {
      const field = comparison[1] === 'deadline' ? 'deadline' : 'due_date';
      const operator = comparison[2] === 'before' ? '<' : comparison[2] === 'after' ? '>' : '=';
      return `(t.${field}<>'' AND t.${field}${operator}${bound(dateTerm(comparison[3] ?? ''))})`;
    }
    invalid('Unsupported filter term');
  }
  function unary(): string {
    const token = tokens[position++];
    if (!token) invalid('Incomplete filter');
    if (token === '!') return `(NOT ${unary()})`;
    if (token === '(') {
      if (++depth > 12) invalid('Filter nesting is too deep');
      const value = or();
      if (tokens[position++] !== ')') invalid('Unclosed filter group');
      depth--;
      return `(${value})`;
    }
    if ([')', '&', '|', ','].includes(token)) invalid('Invalid filter operator');
    return atom(token);
  }
  function and(): string {
    let value = unary();
    while (tokens[position] === '&') {
      position++;
      value = `(${value} AND ${unary()})`;
    }
    return value;
  }
  function or(): string {
    let value = and();
    while (tokens[position] === '|' || tokens[position] === ',') {
      position++;
      value = `(${value} OR ${and()})`;
    }
    return value;
  }
  const sql = or();
  if (position !== tokens.length) invalid('Unexpected filter term');
  return { sql, values };
}
