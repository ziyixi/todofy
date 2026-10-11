import { describe, expect, it } from 'vitest';
import { bundled, compileKeyword, keywordsMatch, loadRegistry, loadTopics, PROFILE_TEXT, RegistryError, reviewOf, SOURCES_TEXT } from '../src/registry.ts';
import { parseYaml, YamlError } from '../src/yaml.ts';

describe('the YAML subset', () => {
  it('reads block mappings, sequences, flow collections over several lines, quotes and comments', () => {
    const doc = parseYaml(`# a comment
version: 1
defaults:
  role: candidate # trailing comment
  enabled: true
sources:
  - id: a
    name: "Quoted # not a comment"
    query: '(cat:cs.CL OR ti:"x")'
    keywords: [seism*, "machine learning",
               AI]
    doi_review: { "10.1038/d41586": news }
  - { id: b, name: B, max_bytes: 262144, ratio: 1.5, nothing: null }
`);
    expect(doc).toEqual({
      version: 1,
      defaults: { role: 'candidate', enabled: true },
      sources: [
        { id: 'a', name: 'Quoted # not a comment', query: '(cat:cs.CL OR ti:"x")', keywords: ['seism*', 'machine learning', 'AI'], doi_review: { '10.1038/d41586': 'news' } },
        { id: 'b', name: 'B', max_bytes: 262144, ratio: 1.5, nothing: null },
      ],
    });
  });

  it('refuses what it does not support, naming the line', () => {
    expect(() => parseYaml('a: 1\na: 2')).toThrow(/line 2: duplicate key "a"/);
    expect(() => parseYaml('a: &anchor 1')).toThrow(YamlError);
    expect(() => parseYaml('a: |\n  text')).toThrow(YamlError);
    expect(() => parseYaml('a:\n\t- 1')).toThrow(/tabs/);
    expect(() => parseYaml('---\na: 1')).toThrow(YamlError);
    expect(() => parseYaml('a: [1, 2')).toThrow(/unclosed/);
    expect(() => parseYaml('a: "open')).toThrow(/unterminated/);
  });
});

describe('the registry', () => {
  it('loads the bundled sources.yaml: 49 enabled, the IDs unique, every URL https', () => {
    const { registry, topics } = bundled();
    const enabled = registry.sources.filter((source) => source.enabled);
    expect(enabled).toHaveLength(49);
    expect(enabled.filter((source) => source.section === 'research')).toHaveLength(36);
    expect(enabled.filter((source) => source.section === 'world')).toHaveLength(13);
    expect(enabled.filter((source) => source.role === 'signal_only')).toHaveLength(4);
    expect(registry.sources.length - enabled.length).toBe(16);
    expect(new Set(registry.sources.map((source) => source.id)).size).toBe(registry.sources.length);
    expect(registry.sources.every((source) => source.url.startsWith('https://'))).toBe(true);
    expect(topics.map((topic) => topic.id)).toContain('geo.seismology');
    expect(SOURCES_TEXT.length).toBeGreaterThan(1000);
  });

  it('applies the defaults and the per-source values', () => {
    const { registry } = bundled();
    const openai = registry.byId.get('openai-news');
    expect(openai?.maxBytes).toBe(262144);
    expect(openai?.maxItems).toBe(20);
    expect(openai?.role).toBe('signal_only');
    const nature = registry.byId.get('nature');
    expect(nature?.pollPerDay).toBe(2);
    expect(nature !== undefined && reviewOf(nature, '10.1038/d41586-026-01234-5')).toBe('news');
    expect(nature !== undefined && reviewOf(nature, '10.1038/s41586-026-01234-5')).toBe('peer_reviewed');
    const arxiv = registry.byId.get('arxiv-llm-agents');
    expect(arxiv?.query).toContain('ti:agent');
    expect(registry.byId.get('anthropic-site')?.pathPrefixes).toEqual(['/research/', '/news/', '/engineering/']);
    expect(registry.byId.get('hf-daily-papers')?.dateOffsetDays).toBe(1);
  });

  it('refuses an unknown field or value, a duplicate ID and a bad URL', () => {
    const base = 'version: 1\nsources:\n  - { id: x, name: X, section: research, kind: rss, url: "https://a.example.org/feed", text: feed_full, review: news';
    expect(() => loadRegistry(`${base} }`)).not.toThrow();
    expect(() => loadRegistry(`${base}, colour: red }`)).toThrow(/unknown field "colour"/);
    expect(() => loadRegistry(`${base}, section: politics }`.replace('section: research, ', ''))).toThrow(/section/);
    expect(() => loadRegistry(`${base} }\n  - { id: x, name: Y, section: world, kind: rss, url: "https://b.example.org", text: feed_full, review: news }`)).toThrow(/duplicate id/);
    expect(() => loadRegistry(base.replace('https://a.example.org/feed', 'http://a.example.org/feed') + ' }')).toThrow(/https only/);
    expect(() => loadRegistry(base.replace('https://a.example.org/feed', 'https://127.0.0.1/feed') + ' }')).toThrow(/DNS name/);
    expect(() => loadRegistry(`${base}, poll_per_day: 3 }`)).toThrow(/poll_per_day/);
    expect(() => loadRegistry(`${base}, query: "x" }`)).toThrow(/query belongs to arxiv_api/);
    expect(() => loadRegistry(`${base}, role: signal_only }`)).toThrow(/signal-only/);
    expect(() => loadRegistry('version: 2\nsources:\n  - {}')).toThrow(RegistryError);
  });

  it('reads the profile topics with their 写法, the owner choice of 2026-10-10 included', () => {
    const topics = loadTopics(PROFILE_TEXT);
    const format = (id: string) => topics.find((topic) => topic.id === id)?.format;
    expect(format('geo.seismology')).toBe('professional');
    expect(format('geo.ml')).toBe('professional');
    expect(format('geo.earth')).toBe('familiar');
    expect(format('llm.architecture')).toBe('familiar');
    expect(format('llm.systems')).toBe('familiar');
    expect(format('llm.agents')).toBe('familiar');
    expect(format('ai4sci')).toBe('plain');
    expect(format('world.economy')).toBe('plain');
    expect(topics.find((topic) => topic.id === 'world.disaster')?.section).toBe('world');
    expect(topics.find((topic) => topic.id === 'llm.systems')?.description).toContain('KV cache');
  });
});

describe('keyword prefilters', () => {
  it('match whole words and phrases, a trailing * as a word start, capitals case-sensitively', () => {
    const fault = [compileKeyword('fault*')];
    expect(keywordsMatch(fault, 'Faults on the plate boundary')).toBe(true);
    expect(keywordsMatch(fault, 'the default setting')).toBe(false);
    const ai = [compileKeyword('AI')];
    expect(keywordsMatch(ai, 'AI for weather')).toBe(true);
    expect(keywordsMatch(ai, 'he said so')).toBe(false);
    expect(keywordsMatch(ai, 'a new domain')).toBe(false);
    expect(keywordsMatch(ai, 'ai lowercase')).toBe(false);
    const phrase = [compileKeyword('neural network*')];
    expect(keywordsMatch(phrase, 'Graph neural  networks for slip')).toBe(true);
    expect(keywordsMatch(phrase, 'neural nets')).toBe(false);
    expect(keywordsMatch([compileKeyword('mantle')], 'Mantle plumes')).toBe(true);
    expect(keywordsMatch([compileKeyword('mantle')], 'mantlepiece')).toBe(false);
    expect(keywordsMatch([], 'anything')).toBe(true);
  });
});
