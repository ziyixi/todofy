/**
 * Label paths (../../docs/design.md §3.1). A label's display name is its path below `分拣/`: one to LABEL_DEPTH_MAX
 * segments joined by `/`, which Gmail shows as nested labels (`分拣/开发/CI通知` under `分拣/开发` under `分拣`).
 * Only leaves are labels: a mail gets exactly one label, so no label's path may be the parent of another's, and the
 * parents exist in Gmail only as grouping labels (created as needed, writes.ts ensureGmailLabel).
 *
 * The same path gives a label its stable, meaningful identifiers: the ID CreateLabel and the import derive when none
 * is given, and the option key the decision model sees (ai.ts). Clef reads each option as `key` with the criterion
 * `path: description`; a random key (`lxy260f75g`, what an import from Gmail used to get) tells it nothing, a key
 * like `finance-invest` repeats the meaning in the alphabet the model's instructions are in. Chinese words become
 * English through a small fixed glossary; a word outside it becomes a short hash of itself, still stable.
 */
import { DISPLAY_NAME_MAX, LABEL_DEPTH_MAX, LABEL_ID_PATTERN, LABEL_PREFIX, LABEL_ROOT, LABEL_SEGMENT_MAX, NONE } from './limits.ts';

/** Whether `text` has a control character (C0, DEL or C1). */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * The normalized path of `raw` (segments trimmed, empty input refused), or null when it breaks a rule: at most
 * LABEL_DEPTH_MAX non-empty segments of LABEL_SEGMENT_MAX characters, no control characters, DISPLAY_NAME_MAX in all,
 * and a first segment other than the prefix's own root: a path is below `分拣/` already, so `分拣/x` would be the Gmail
 * label `分拣/分拣/x` (with a grouping label `分拣/分拣`).
 */
export function normalizePath(raw: string): string | null {
  if (hasControlChar(raw)) return null;
  const segments = raw.split('/').map((segment) => segment.trim());
  if (segments.length === 0 || segments.length > LABEL_DEPTH_MAX) return null;
  if (segments.some((segment) => segment === '' || Array.from(segment).length > LABEL_SEGMENT_MAX)) return null;
  if (segments[0] === LABEL_ROOT) return null;
  const path = segments.join('/');
  return Array.from(path).length <= DISPLAY_NAME_MAX ? path : null;
}

/**
 * The path the owner typed in 标签 (CreateLabel, a rename): the path below `分拣/`, and the same with that prefix
 * written out (`分拣/金融/投资` is `金融/投资`, as an import reads a rule's label), so both entry points agree. Null as
 * normalizePath.
 */
export function ownerPath(raw: string): string | null {
  const trimmed = raw.trim();
  return normalizePath(trimmed.startsWith(LABEL_PREFIX) ? trimmed.slice(LABEL_PREFIX.length) : trimmed);
}

/** The path of a Gmail name under the prefix (`分拣/开发/CI通知` -> `开发/CI通知`), or null for any other name. */
export function pathOfGmailName(name: string): string | null {
  if (!name.startsWith(LABEL_PREFIX)) return null;
  const path = normalizePath(name.slice(LABEL_PREFIX.length));
  // Only the normalized spelling is ours: `分拣/ a` is another Gmail label than `分拣/a`.
  return path !== null && `${LABEL_PREFIX}${path}` === name ? path : null;
}

/** The Gmail names of a path's parents, outermost first: `开发/CI通知` -> [`分拣`, `分拣/开发`]. */
export function parentGmailNames(path: string): string[] {
  const segments = path.split('/');
  const out = [LABEL_PREFIX.slice(0, -1)];
  for (let i = 1; i < segments.length; i++) out.push(`${LABEL_PREFIX}${segments.slice(0, i).join('/')}`);
  return out;
}

/** The top-level segment (the group the UI colors a label by). */
export function topLevel(path: string): string {
  return path.split('/')[0] ?? path;
}

/** Whether `a` is a parent (or grandparent) of `b`. */
export function isAncestor(a: string, b: string): boolean {
  return b.startsWith(`${a}/`);
}

/** The path among `others` that `path` would nest with (a parent or a child of it), or null: only leaves are labels. */
export function treeConflict(path: string, others: Iterable<string>): string | null {
  for (const other of others) if (other !== path && (isAncestor(other, path) || isAncestor(path, other))) return other;
  return null;
}

/**
 * Chinese words of label paths and their English slug, longest first where one contains another. Words that only
 * join others (与, 和, 及) map to nothing. A word outside the glossary falls back to `x` and a short hash of itself
 * (segmentSlug), so a key stays stable; the other words of the path keep their English (`金融/猫咪` is
 * `finance-x1b2c`), so a key is at least partly meaningful.
 */
const GLOSSARY: Readonly<Record<string, string>> = {
  信用卡: 'card',
  验证码: 'codes',
  开发: 'dev',
  通知: 'notices',
  平台: 'platform',
  工具: 'tools',
  金融: 'finance',
  投资: 'invest',
  理财: 'wealth',
  股票: 'stocks',
  基金: 'funds',
  银行: 'bank',
  支付: 'pay',
  账号: 'account',
  帐号: 'account',
  账户: 'account',
  安全: 'security',
  登录: 'login',
  验证: 'verify',
  政府: 'gov',
  法律: 'legal',
  税务: 'tax',
  证件: 'ids',
  购物: 'shop',
  订单: 'orders',
  物流: 'shipping',
  快递: 'parcels',
  取件: 'pickup',
  促销: 'promo',
  优惠: 'deals',
  营销: 'marketing',
  广告: 'ads',
  订阅: 'subscriptions',
  收据: 'receipts',
  发票: 'invoices',
  退款: 'refunds',
  出行: 'travel',
  旅行: 'travel',
  航班: 'flights',
  机票: 'flights',
  火车: 'trains',
  酒店: 'hotels',
  会员: 'membership',
  生活: 'life',
  账单: 'bills',
  缴费: 'payments',
  住房: 'housing',
  房租: 'rent',
  水电: 'utilities',
  宽带: 'broadband',
  话费: 'phone',
  汽车: 'car',
  医疗: 'health',
  健康: 'health',
  医院: 'hospital',
  保险: 'insurance',
  求职: 'jobs',
  招聘: 'recruiting',
  工作: 'work',
  学校: 'school',
  学术: 'academic',
  课程: 'courses',
  论文: 'papers',
  期刊: 'journals',
  审稿: 'reviews',
  会议: 'meetings',
  社群: 'community',
  社交: 'social',
  个人: 'personal',
  家庭: 'family',
  新闻: 'news',
  简报: 'newsletter',
  周报: 'weekly',
  云: 'cloud',
  服务: 'services',
  系统: 'system',
  告警: 'alerts',
  监控: 'monitoring',
  其他: 'other',
  杂项: 'misc',
  重要: 'important',
  // Words a personal mailbox's own labels are likely to use (QA D8: most of the owner's custom labels fell back to
  // hashes). Longer words win over the single characters below.
  家人: 'family',
  亲友: 'family-friends',
  朋友: 'friends',
  孩子: 'kids',
  宠物: 'pets',
  报税: 'tax-filing',
  报销: 'reimburse',
  工资: 'payroll',
  测试: 'test',
  科研: 'research',
  研究: 'research',
  实验室: 'lab',
  导师: 'advisor',
  同事: 'colleagues',
  公司: 'company',
  团队: 'team',
  项目: 'project',
  合同: 'contracts',
  简历: 'resume',
  面试: 'interviews',
  签证: 'visa',
  移民: 'immigration',
  护照: 'passport',
  驾照: 'license',
  租房: 'rent',
  房东: 'landlord',
  物业: 'property',
  燃气: 'gas',
  外卖: 'delivery',
  餐饮: 'dining',
  美食: 'food',
  电影: 'movies',
  音乐: 'music',
  游戏: 'games',
  读书: 'reading',
  运动: 'sports',
  健身: 'fitness',
  捐款: 'donations',
  公益: 'charity',
  社区: 'neighborhood',
  校友: 'alumni',
  大学: 'university',
  学生: 'students',
  老师: 'teachers',
  考试: 'exams',
  奖学金: 'scholarship',
  活动: 'events',
  通讯: 'newsletter',
  资讯: 'news',
  博客: 'blogs',
  论坛: 'forums',
  开源: 'opensource',
  代码: 'code',
  域名: 'domains',
  服务器: 'servers',
  数据库: 'database',
  // Single characters, only where no longer word matches: numbers and a few that stand alone in short labels.
  一: 'one',
  二: 'two',
  三: 'three',
  四: 'four',
  五: 'five',
  家: 'home',
  税: 'tax',
  车: 'car',
  房: 'house',
  书: 'books',
  药: 'medicine',
  与: '',
  和: '',
  及: '',
};
const GLOSSARY_LONGEST = Math.max(...Object.keys(GLOSSARY).map((word) => word.length));

/** FNV-1a of `text`, 4 hex digits: a stable stand-in for a word the glossary does not know. */
function shortHash(text: string): string {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619) >>> 0;
  return (hash & 0xffff).toString(16).padStart(4, '0');
}

/** One segment's slug: its ASCII words in lower case and the glossary's words, in order. */
function segmentSlug(segment: string): string {
  const words: string[] = [];
  let unknown = '';
  const flushUnknown = () => {
    if (unknown !== '') words.push(`x${shortHash(unknown)}`);
    unknown = '';
  };
  let i = 0;
  while (i < segment.length) {
    const ascii = /^[A-Za-z0-9]+/.exec(segment.slice(i));
    if (ascii !== null) {
      flushUnknown();
      words.push(ascii[0].toLowerCase());
      i += ascii[0].length;
      continue;
    }
    let matched = false;
    for (let length = Math.min(GLOSSARY_LONGEST, segment.length - i); length >= 1; length--) {
      const english = GLOSSARY[segment.slice(i, i + length)];
      if (english !== undefined) {
        flushUnknown();
        if (english !== '') words.push(english);
        i += length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const char = segment.slice(i, i + 1);
    // Spaces and punctuation separate words; any other character is part of an unknown word.
    if (/^[\s\p{P}\p{S}]$/u.test(char)) flushUnknown();
    else unknown += char;
    i += 1;
  }
  flushUnknown();
  return words.join('-');
}

/** The slug of a path: `开发/CI通知` -> `dev-ci-notices`, `金融/投资` -> `finance-invest`. At most 40 characters. */
export function pathSlug(path: string): string {
  let slug = path
    .split('/')
    .map(segmentSlug)
    .filter((part) => part !== '')
    .join('-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug === '') slug = `x${shortHash(path)}`;
  if (!/^[a-z]/.test(slug)) slug = `l-${slug}`;
  slug = slug.slice(0, 40).replace(/-$/, '');
  return slug === NONE ? `${NONE}-label` : slug;
}

/** A new label's ID from its path, unique among `taken` (`-2`, `-3`, ... when needed); null when none fits. */
export function labelIdFor(path: string, taken: ReadonlySet<string>): string | null {
  const base = pathSlug(path);
  for (let n = 1; n < 100; n++) {
    const suffix = n === 1 ? '' : `-${String(n)}`;
    const id = `${base.slice(0, 40 - suffix.length).replace(/-$/, '')}${suffix}`;
    if (LABEL_ID_PATTERN.test(id) && id !== NONE && !taken.has(id)) return id;
  }
  return null;
}

/**
 * The decision model's option keys of `labels` (in their order): each path's slug, made unique with `-2`, `-3` in
 * that order. Stable while the paths and their order are: the same labels always get the same keys.
 */
export function optionKeys(labels: readonly { readonly id: string; readonly path: string }[]): Map<string, string> {
  const used = new Set<string>([NONE]);
  const out = new Map<string, string>();
  for (const label of labels) {
    const base = pathSlug(label.path);
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base.slice(0, 36)}-${String(n)}`;
    used.add(key);
    out.set(label.id, key);
  }
  return out;
}
