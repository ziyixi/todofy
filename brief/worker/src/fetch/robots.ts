/**
 * robots.txt for article pages (../../../docs/design.md §3.3, as the owner decided on 2026-10-10: "相当于我自己抓").
 * The brief fetches a publicly reachable page the way the owner's own browser would, for the owner alone: robots
 * blocks aimed at AI agents (Claude-User, ChatGPT-User, ClaudeBot, GPTBot, ...) and the generic `*` group do not
 * apply. What it still honours, as politeness:
 *
 * - a group that names the brief's own product token (`ziyixi-brief`): its Disallow and Allow rules (RFC 9309: the
 *   longest match wins, Allow on a tie);
 * - the Crawl-delay of that group, else of `*`, as the host's spacing (the per-host pacing of design §3.2).
 *
 * Feeds and APIs are always fetched (they are published for polling; arXiv's API is governed by its terms). A paywall
 * or a login is never worked around: the page then reads as no full text and the feed's text is used (page.ts).
 * An answer of 4xx allows everything; a 5xx or no answer disallows everything for an hour (the RFC's rule: the file
 * might name the brief).
 */
import { CRAWL_DELAY_MAX_MS, ROBOTS_TOKEN } from '../limits.ts';

export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
}

export interface RobotsVerdict {
  /** The rules of a group that names the brief's token (empty: none, or a group without rules). */
  readonly rules: readonly RobotsRule[];
  /** Everything is disallowed (a 5xx or no answer). */
  readonly disallowAll: boolean;
  /** The Crawl-delay that applies, in milliseconds (0: none). */
  readonly crawlDelayMs: number;
}

const RULES_MAX = 500;

function parseDelay(value: string): number | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(CRAWL_DELAY_MAX_MS, Math.round(seconds * 1000));
}

/** The verdict of a robots.txt text for the brief's token. */
export function parseRobots(text: string, token: string = ROBOTS_TOKEN): RobotsVerdict {
  const own: RobotsRule[] = [];
  let ownDelay: number | null = null;
  let starDelay: number | null = null;
  let agents: string[] = [];
  let inRules = false;
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
      agents.push(value.toLowerCase().split('/')[0] ?? '');
      continue;
    }
    if (field !== 'allow' && field !== 'disallow' && field !== 'crawl-delay') continue;
    inRules = true;
    const ours = agents.includes(token);
    if (field === 'crawl-delay') {
      const delay = parseDelay(value);
      if (delay !== null && ours) ownDelay = delay;
      else if (delay !== null && agents.includes('*')) starDelay = delay;
      continue;
    }
    if (!ours || value === '' || own.length >= RULES_MAX) continue;
    own.push({ allow: field === 'allow', pattern: value });
  }
  return { rules: own, disallowAll: false, crawlDelayMs: ownDelay ?? starDelay ?? 0 };
}

/** The verdict of an answer to /robots.txt (status 0: no answer). */
export function robotsFromAnswer(status: number, body: string | null): RobotsVerdict {
  if (status >= 200 && status < 300) return parseRobots(body ?? '');
  if (status >= 400 && status < 500) return { rules: [], disallowAll: false, crawlDelayMs: 0 };
  return { rules: [], disallowAll: true, crawlDelayMs: 0 };
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
    if (index === parts.length - 1 && anchored) return path.length - part.length >= position && path.endsWith(part);
    const found = path.indexOf(part, position);
    if (found < 0) return false;
    position = found + part.length;
  }
  return !anchored || position === path.length;
}

/** Whether the verdict lets the brief fetch `pathAndQuery`. */
export function robotsAllows(verdict: RobotsVerdict, pathAndQuery: string): boolean {
  if (verdict.disallowAll) return false;
  let best: RobotsRule | null = null;
  for (const rule of verdict.rules) {
    if (!patternMatches(rule.pattern, pathAndQuery)) continue;
    const longer = best === null || rule.pattern.length > best.pattern.length;
    const tieAllow = best !== null && rule.pattern.length === best.pattern.length && rule.allow && !best.allow;
    if (longer || tieAllow) best = rule;
  }
  return best === null || best.allow;
}
