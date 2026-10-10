// The segmenter (shared/segment.ts), query building and snippets (src/search.ts): CJK runs as pairs, mixed runs, lone
// characters, NFKC; phrases, quote doubling, the term and length bounds, QUERY_NOT_SEARCHABLE; snippets around the
// first match with every occurrence highlighted.
import { describe, expect, it } from 'vitest';
import { searchable, segment, tokensOf } from '../../shared/segment.ts';
import { highlightWords, phrase, QueryError, readQuery, snippetOf, splitTerms } from '../src/search.ts';

describe('segment', () => {
  it('turns a CJK run into overlapping pairs set apart from Latin and digits', () => {
    expect(tokensOf(segment('数据库'))).toEqual(['数据', '据库']);
    expect(tokensOf(segment('D1数据库'))).toEqual(['d1', '数据', '据库']);
    expect(tokensOf(segment('用 FTS5 做中文搜索'))).toEqual(['用', 'fts5', '做中', '中文', '文搜', '搜索']);
    expect(tokensOf(segment('東京タワー'))).toEqual(['東京', '京タ', 'タワ', 'ワー']);
    expect(tokensOf(segment('한국어 검색'))).toEqual(['한국', '국어', '검색']);
  });

  it('keeps a lone CJK character as itself, and folds width and case (NFKC)', () => {
    expect(tokensOf(segment('数'))).toEqual(['数']);
    expect(tokensOf(segment('ＡＢＣ１２３'))).toEqual(['abc123']);
    expect(tokensOf(segment('ｶﾀｶﾅ'))).toEqual(['カタ', 'タカ', 'カナ']);
    expect(tokensOf(segment('Durable Objects 入门'))).toEqual(['durable', 'objects', '入门']);
  });

  it('pairs astral Han characters whole', () => {
    expect(tokensOf(segment('𠀀𠀁𠀂'))).toEqual(['𠀀𠀁', '𠀁𠀂']);
  });

  it('a term is searchable when it has a token other than a lone CJK character', () => {
    expect(searchable('数据')).toBe(true);
    expect(searchable('a')).toBe(true);
    expect(searchable('数')).toBe(false);
    expect(searchable('数，据')).toBe(false);
    expect(searchable('!?')).toBe(false);
  });
});

describe('query building', () => {
  it('splits on spaces, a double-quoted phrase is one term, an unclosed quote runs to the end', () => {
    expect(splitTerms('durable  alarm')).toEqual(['durable', 'alarm']);
    expect(splitTerms('"冷启动 优化" worker')).toEqual(['冷启动 优化', 'worker']);
    expect(splitTerms('a "b c')).toEqual(['a', 'b c']);
    expect(splitTerms('  ')).toEqual([]);
  });

  it('writes each term as an FTS5 phrase of its segments with every quote doubled, all terms required', () => {
    expect(phrase('数据库')).toBe('"数据 据库"');
    expect(readQuery('durable "冷启动 优化"')).toEqual({ match: '"durable" "冷启 启动 优化"', terms: ['durable', '冷启动 优化'] });
    expect(phrase('say "hi"')).toBe('"say ""hi"""');
    expect(readQuery('title:x OR NEAR(a b) *').match).toBe('"title:x" "or" "near(a" "b)"');
    expect(readQuery('')).toEqual({ match: null, terms: [] });
  });

  it('reads a lone CJK character beside Latin letters or digits as a prefix at the end and leaves it out at the start', () => {
    expect(phrase('iOS版')).toBe('"ios 版"*');
    expect(phrase('2026年')).toBe('"2026 年"*');
    expect(phrase('新iPhone')).toBe('"iphone"');
    expect(phrase('新iPhone版')).toBe('"iphone 版"*');
    expect(phrase('a版b')).toBe('"a 版 b"');
    expect(readQuery('iOS版 数据库')).toEqual({ match: '"ios 版"* "数据 据库"', terms: ['iOS版', '数据库'] });
  });

  it('drops terms with nothing to find, and refuses a query left with none', () => {
    expect(readQuery('数 durable !!').terms).toEqual(['durable']);
    const refused = (query: string) => {
      try {
        readQuery(query);
      } catch (error) {
        return error instanceof QueryError ? error.reason : 'other';
      }
      return 'accepted';
    };
    expect(refused('数')).toBe('QUERY_NOT_SEARCHABLE');
    expect(refused('数 据 !')).toBe('QUERY_NOT_SEARCHABLE');
    expect(refused('a '.repeat(11))).toBe('BAD_REQUEST');
    expect(refused('a'.repeat(201))).toBe('BAD_REQUEST');
    expect(refused('中'.repeat(200))).toBe('accepted');
  });
});

describe('snippets', () => {
  const text = `${'前言。'.repeat(40)}这一段讲 Durable Object 的冷启动，以及如何优化冷启动时间。${'后记。'.repeat(60)}`;

  it('cuts about 160 characters around the first match and highlights every occurrence', () => {
    const segments = snippetOf(text, ['冷启动']);
    const joined = segments.map((s) => s.text).join('');
    expect(joined.length).toBeLessThanOrEqual(170);
    expect(joined.startsWith('…')).toBe(true);
    expect(joined.endsWith('…')).toBe(true);
    expect(segments.filter((s) => s.highlighted).map((s) => s.text)).toEqual(['冷启动', '冷启动']);
  });

  it('matches ignoring case and width, highlights a phrase word by word, and collapses whitespace', () => {
    const segments = snippetOf('Intro\n\n  The ＤＵＲＡＢＬＥ   object.', ['durable object']);
    expect(segments).toEqual([
      { text: 'Intro The ', highlighted: false },
      { text: 'ＤＵＲＡＢＬＥ', highlighted: true },
      { text: ' ', highlighted: false },
      { text: 'object', highlighted: true },
      { text: '.', highlighted: false },
    ]);
    expect(highlightWords(['Durable object', 'durable'])).toEqual(['durable', 'object']);
  });

  it('is empty when no word occurs in the text', () => {
    expect(snippetOf(text, ['不存在的词'])).toEqual([]);
    expect(snippetOf('', ['a'])).toEqual([]);
  });

  it('starts and ends at word boundaries in Latin text', () => {
    const latin = `${'alpha beta gamma delta '.repeat(20)}the needle sits here ${'omega psi chi phi '.repeat(20)}`;
    const joined = snippetOf(latin, ['needle']).map((s) => s.text).join('');
    const words = joined.replaceAll('…', '').trim().split(' ');
    expect(['alpha', 'beta', 'gamma', 'delta', 'the']).toContain(words[0]);
    expect(['omega', 'psi', 'chi', 'phi']).toContain(words[words.length - 1]);
  });
});
