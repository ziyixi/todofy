/**
 * The denylist (../docs/design.md §3.7): what recall never records, records by its site alone, or records without its
 * text. The extension applies it before a visit or a capture enters its outbox, and the Worker applies it again to
 * every item it receives, so a change holds at once and an older build cannot let anything through.
 *
 * A pattern is a host, which covers its subdomains (`example.com` matches `www.example.com`), or a host and a path
 * prefix that ends at a segment boundary, ignoring case (`example.com/account` matches `/account`, `/Account/x`, not
 * `/accounts`): a path that differs only in case may well serve the same page, and the stricter reading is the safe
 * one. A URL is judged by its path and, for a hash router (`#/accounts/1`, `#!/accounts`), by its route as well; a
 * host's trailing dot (`mail.google.com.`) is ignored. Three levels, the strictest that matches wins:
 *
 * - never: recall's own host, so the owner's searches never enter the archive;
 * - site_only: one page per site (its root URL), no title, never text: mail, messaging and AI chats, consoles (API
 *   keys among them), identity and account pages, password managers, payments and banks (generic names only; the
 *   owner's own banks go in their list, never in this public file), and the owner's site-only patterns. The owner
 *   chose to record these by their site alone (§12);
 * - no_text: the URL and title are recorded, the text never: the owner's other apps, login and authorization paths,
 *   and the owner's no-text patterns (Settings.denylist_patterns).
 */

export type DenyLevel = 'record' | 'no_text' | 'site_only' | 'never';

/** recall's public host (a build constant of the extension; the Worker passes its PUBLIC_HOST too). */
export const RECALL_HOST = 'recall.ziyixi.science';

/** Pages recorded by their site alone. */
export const SITE_ONLY_PATTERNS: readonly string[] = [
  // mail
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'app.fastmail.com',
  'icloud.com',
  // messaging and AI chats (other people's words as well as the owner's)
  'web.whatsapp.com',
  'web.telegram.org',
  'app.slack.com',
  'discord.com',
  'messenger.com',
  'facebook.com/messages',
  'instagram.com/direct',
  'linkedin.com/messaging',
  'x.com/messages',
  'x.com/i/chat',
  'wx.qq.com',
  'web.wechat.com',
  'teams.microsoft.com',
  'teams.live.com',
  'chatgpt.com',
  'chat.openai.com',
  'claude.ai',
  'gemini.google.com',
  'chat.deepseek.com',
  'messages.google.com',
  'voice.google.com',
  'chat.google.com',
  // consoles, the API key consoles of AI providers, package registries and code hosts among them
  'dash.cloudflare.com',
  'one.dash.cloudflare.com',
  'cloudflareaccess.com',
  'console.cloud.google.com',
  'console.aws.amazon.com',
  'portal.azure.com',
  'console.firebase.google.com',
  'github.com/settings',
  'gitlab.com/-/user_settings',
  'gitlab.com/-/profile',
  'console.anthropic.com',
  'platform.claude.com',
  'platform.openai.com',
  'aistudio.google.com',
  'platform.deepseek.com',
  'console.groq.com',
  'console.mistral.ai',
  'openrouter.ai/settings',
  'huggingface.co/settings',
  'npmjs.com/settings',
  'pypi.org/manage',
  'hub.docker.com/settings',
  'app.docker.com/settings',
  'vercel.com/account',
  // identity and accounts
  'accounts.google.com',
  'myaccount.google.com',
  'admin.google.com',
  'passwords.google.com',
  'pay.google.com',
  'appleid.apple.com',
  'account.apple.com',
  'idmsa.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'account.microsoft.com',
  'okta.com',
  'auth0.com',
  'github.com/login',
  'github.com/sessions',
  // password managers
  '1password.com',
  'bitwarden.com',
  'lastpass.com',
  'dashlane.com',
  'keepersecurity.com',
  // payments and banks, generic only
  'paypal.com',
  'venmo.com',
  'wise.com',
  'stripe.com',
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'citi.com',
  'capitalone.com',
  'americanexpress.com',
  'discover.com',
  'schwab.com',
  'fidelity.com',
  'vanguard.com',
  'robinhood.com',
  'coinbase.com',
  'alipay.com',
  '95516.com',
];

/** Hosts recorded without their text (the owner's other apps). */
export const NO_TEXT_PATTERNS: readonly string[] = ['ziyixi.science'];

/** Path segments (any position, ignoring case) of pages recorded without their text: sign-in and authorization. */
export const NO_TEXT_SEGMENTS: readonly string[] = ['login', 'signin', 'sign-in', 'logout', 'oauth', 'oauth2', 'authorize', 'sso', 'saml'];

/** The owner's patterns, both lists together: at most this many, each at most PATTERN_MAX_CHARS. */
export const OWNER_PATTERNS_MAX = 200;
export const PATTERN_MAX_CHARS = 200;

export interface Pattern {
  /** A lower-case host. */
  readonly host: string;
  /** '' or a path prefix starting with `/` and not ending with one. */
  readonly path: string;
}

/** The owner's patterns (Settings): pages recorded by their site alone, and pages recorded without their text. */
export interface OwnerPatterns {
  readonly siteOnly: readonly Pattern[];
  readonly noText: readonly Pattern[];
}

export const NO_OWNER_PATTERNS: OwnerPatterns = { siteOnly: [], noText: [] };

/** A host as a pattern names it: labels of letters, digits, `-` and `_` (the archive's Site format allows `_`). */
const HOST = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;
const PATH = /^(?:\/[!$&'()*+,;=:@A-Za-z0-9._~%-]+)+$/;

/**
 * A pattern from its text (`example.com` or `example.com/account`, lower case, no scheme, query or fragment, at most
 * PATTERN_MAX_CHARS characters), or null. A trailing `/` is dropped.
 */
export function parsePattern(text: string): Pattern | null {
  if (text.length === 0 || text.length > PATTERN_MAX_CHARS) return null;
  const slash = text.indexOf('/');
  const host = slash === -1 ? text : text.slice(0, slash);
  const path = slash === -1 ? '' : text.slice(slash).replace(/\/+$/, '');
  if (host.length > 253 || !HOST.test(host)) return null;
  if (path !== '' && !PATH.test(path)) return null;
  return { host, path };
}

/** A pattern's canonical text (what parsePattern read, without a trailing `/`). */
export function patternText(pattern: Pattern): string {
  return `${pattern.host}${pattern.path}`;
}

/** Pattern texts compiled (a text that does not parse is skipped). */
export function compilePatterns(texts: readonly string[]): Pattern[] {
  return texts.map(parsePattern).filter((pattern): pattern is Pattern => pattern !== null);
}

/** Whether a host is the pattern's host or one of its subdomains. */
export function hostMatches(host: string, patternHost: string): boolean {
  return host === patternHost || host.endsWith(`.${patternHost}`);
}

/** Whether a URL's host and one of its paths match a pattern (the path prefix ignoring case). */
export function matches(pattern: Pattern, host: string, paths: string | readonly string[]): boolean {
  if (!hostMatches(host, pattern.host)) return false;
  if (pattern.path === '') return true;
  const prefix = pattern.path.toLowerCase();
  return (typeof paths === 'string' ? [paths] : paths).some((path) => {
    const lower = path.toLowerCase();
    return lower === prefix || lower.startsWith(`${prefix}/`);
  });
}

const SITE_ONLY = compilePatterns(SITE_ONLY_PATTERNS);
const NO_TEXT = compilePatterns(NO_TEXT_PATTERNS);
const SEGMENTS = new Set(NO_TEXT_SEGMENTS);

/** Whether a path has a sign-in or authorization segment. */
export function hasSignInSegment(path: string): boolean {
  return path.split('/').some((segment) => SEGMENTS.has(segment.toLowerCase()));
}

/**
 * The paths a URL is judged by: its path and, for a hash router (a fragment starting with `#/` or `#!`), its route
 * without the route's query (`#!/accounts/1?tab=2` is `/accounts/1`).
 */
export function routePaths(pathname: string, hash: string): string[] {
  if (!hash.startsWith('#/') && !hash.startsWith('#!')) return [pathname];
  const route = hash.slice(hash.startsWith('#!') ? 2 : 1).split('?', 1)[0] ?? '';
  return [pathname, route.startsWith('/') ? route : `/${route}`];
}

/**
 * The level of a URL (its host and its paths: routePaths), given the owner's patterns and recall's own hosts (the
 * extension's build constant RECALL_HOST, the Worker's PUBLIC_HOST).
 */
export function denyLevel(host: string, paths: string | readonly string[], owner: OwnerPatterns, ownHosts: readonly string[] = [RECALL_HOST]): DenyLevel {
  const bare = host.toLowerCase().replace(/\.+$/, '');
  const all = typeof paths === 'string' ? [paths] : paths;
  if (ownHosts.some((own) => own !== '' && hostMatches(bare, own))) return 'never';
  if ([...SITE_ONLY, ...owner.siteOnly].some((pattern) => matches(pattern, bare, all))) return 'site_only';
  if ([...NO_TEXT, ...owner.noText].some((pattern) => matches(pattern, bare, all))) return 'no_text';
  return all.some(hasSignInSegment) ? 'no_text' : 'record';
}

/** The level of a URL string (http or https); 'never' for a URL that does not parse. */
export function denyLevelOfUrl(url: string, owner: OwnerPatterns, ownHosts?: readonly string[]): DenyLevel {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'never';
  }
  return denyLevel(parsed.hostname, routePaths(parsed.pathname, parsed.hash), owner, ownHosts);
}

/** The built-in no-text rules in the form the settings show them: the hosts, then each sign-in segment after `*` and `/`. */
export function builtinNoTextPatterns(): string[] {
  return [...NO_TEXT_PATTERNS, ...NO_TEXT_SEGMENTS.map((segment) => `*/${segment}`)];
}
