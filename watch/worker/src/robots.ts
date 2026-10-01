/**
 * robots.txt (RFC 9309) for one agent: parsing a file into the rules that apply to ROBOTS_AGENT, and matching a path
 * against them. Pure functions; WatchState caches the verdict per host (ROBOTS_TTL_MS) in its `robots` table.
 *
 * - The group whose user-agent line matches the product token (case-insensitively) applies; otherwise the `*` group;
 *   otherwise everything is allowed. Consecutive user-agent lines share a group; several groups for the same agent are
 *   merged.
 * - The longest matching rule wins; on a tie, `allow` wins. `*` matches any run of characters and a trailing `$`
 *   anchors the end. Paths compare percent-encoded as the URL parser writes them.
 * - How an answer is read: 2xx parses; 4xx (no file) allows everything; 5xx, a network failure or a timeout
 *   disallows everything (RFC 9309 §2.3.1.4), cached only for ROBOTS_ERROR_TTL_MS.
 */
import { ROBOTS_AGENT } from './limits.ts';

export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
}

/** What a host's robots.txt says for this agent. */
export type RobotsVerdict = { readonly kind: 'rules'; readonly rules: readonly RobotsRule[] } | { readonly kind: 'allow_all' } | { readonly kind: 'disallow_all' };

/** At most this many rules are kept from one file. */
const RULES_MAX = 1000;

/** The rules of `text` that apply to `agent`. */
export function parseRobots(text: string, agent: string = ROBOTS_AGENT): RobotsVerdict {
  const token = agent.toLowerCase();
  const specific: RobotsRule[] = [];
  const generic: RobotsRule[] = [];
  let agents: string[] = [];
  let inRules = false;
  let matchedSpecific = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(value.toLowerCase());
      continue;
    }
    if (field !== 'allow' && field !== 'disallow') continue;
    inRules = true;
    // An empty Disallow allows everything: it adds no rule.
    if (value === '') continue;
    const rule = { allow: field === 'allow', pattern: value };
    if (agents.some((name) => isThisAgent(name, token))) {
      if (specific.length < RULES_MAX) specific.push(rule);
    } else if (agents.includes('*') && generic.length < RULES_MAX) {
      generic.push(rule);
    }
  }
  // A group that names this agent applies even when it holds no rule (then everything is allowed).
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const match = /^\s*user-agent\s*:\s*([^#\s]+)/i.exec(raw);
    if (match?.[1] !== undefined && isThisAgent(match[1].toLowerCase(), token)) matchedSpecific = true;
  }
  const rules = matchedSpecific ? specific : generic;
  return rules.length === 0 ? { kind: 'allow_all' } : { kind: 'rules', rules };
}

/** Whether a user-agent line's value (lower case) names this agent: its product token, with or without a version. */
function isThisAgent(name: string, token: string): boolean {
  return name !== '*' && name.split('/')[0] === token;
}

/** Whether `pattern` (with `*` and a trailing `$`) matches the start of `path`. */
export function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split('*');
  let position = 0;
  for (const [index, part] of parts.entries()) {
    if (index === 0) {
      if (!path.startsWith(part)) return false;
      position = part.length;
      continue;
    }
    if (index === parts.length - 1 && anchored) {
      return path.length - part.length >= position && path.endsWith(part);
    }
    const found = path.indexOf(part, position);
    if (found < 0) return false;
    position = found + part.length;
  }
  return !anchored || position === path.length;
}

/** Whether the verdict lets this agent fetch `pathAndQuery` (`/a/b?c`). */
export function robotsAllows(verdict: RobotsVerdict, pathAndQuery: string): boolean {
  if (verdict.kind === 'allow_all') return true;
  if (verdict.kind === 'disallow_all') return false;
  let best: RobotsRule | null = null;
  for (const rule of verdict.rules) {
    if (!patternMatches(rule.pattern, pathAndQuery)) continue;
    const longer = best === null || rule.pattern.length > best.pattern.length;
    const tieAllow = best !== null && rule.pattern.length === best.pattern.length && rule.allow && !best.allow;
    if (longer || tieAllow) best = rule;
  }
  return best === null || best.allow;
}

/** The verdict of an HTTP answer to /robots.txt (status, body), or of no answer (status 0). */
export function robotsFromAnswer(status: number, body: string | null): RobotsVerdict {
  if (status >= 200 && status < 300) return parseRobots(body ?? '');
  if (status >= 400 && status < 500) return { kind: 'allow_all' };
  return { kind: 'disallow_all' };
}
