import { LinkSchema } from '@ziyixi/proto/links/ui/v1/link_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { describe, expect, it } from 'vitest';
import { linkMessage, linkWire, PATH_MODES, sameContent, tagsOf, VISIBILITIES, wireTime, type LinkRow } from '../src/model.ts';

const T0 = Date.parse('2026-10-01T08:00:00Z');

function row(overrides: Partial<LinkRow> = {}): LinkRow {
  return {
    key: 'gh',
    target: 'https://example.com/',
    path_mode: 'exact',
    visibility: 'private',
    description: '',
    tags: '[]',
    expire_time: null,
    create_time: T0,
    update_time: T0,
    delete_time: null,
    purge_time: null,
    revision: 1,
    revision_time: T0,
    etag: '0123456789abcdef',
    ...overrides,
  };
}

describe('the stored enums are the wire names', () => {
  it('lists every mode and visibility', () => {
    expect(PATH_MODES.names).toEqual(['exact', 'append', 'template']);
    expect(VISIBILITIES.names).toEqual(['private', 'public']);
  });
});

describe('linkWire', () => {
  it('equals toWire of the message for every kind of row', () => {
    const rows = [
      row(),
      row({ path_mode: 'append', visibility: 'public', description: 'Code «host»', tags: '["dev","git"]' }),
      row({ path_mode: 'template', target: 'https://example.com/?q={path}', expire_time: T0 + 1234, revision: 7, revision_time: T0 + 5 }),
      row({ delete_time: T0 + 1000, purge_time: T0 + 30 * 86_400_000, update_time: T0 + 1000 }),
      row({ tags: 'not json' }),
    ];
    for (const value of rows) {
      const viaMessage = JSON.stringify(toWire(LinkSchema, linkMessage(value)));
      expect(JSON.stringify(linkWire(value))).toBe(viaMessage);
      // And it reads back strictly as the same link (what ImportLinks does with an export line).
      expect(fromWire(LinkSchema, JSON.parse(viaMessage), { strict: true }).message.name).toBe('links/gh');
    }
  });

  it('writes timestamps in the profile canonical form', () => {
    expect(wireTime(T0)).toBe('2026-10-01T08:00:00Z');
    expect(wireTime(T0 + 5)).toBe('2026-10-01T08:00:00.005Z');
  });
});

describe('content', () => {
  it('reads stored tags leniently and compares every content field', () => {
    expect(tagsOf('["a","b"]')).toEqual(['a', 'b']);
    expect(tagsOf('[1,"a"]')).toEqual(['a']);
    expect(tagsOf('{')).toEqual([]);
    expect(sameContent(row(), row({ etag: 'other', revision: 9 }))).toBe(true);
    for (const change of [{ target: 'https://example.org/' }, { path_mode: 'append' }, { visibility: 'public' }, { description: 'x' }, { tags: '["x"]' }, { expire_time: 1 }] as const) {
      expect(sameContent(row(), row(change)), JSON.stringify(change)).toBe(false);
    }
  });

  it('names a revision with its number and time', () => {
    const message = linkMessage(row({ revision: 3 }), { ...row({ target: 'https://example.org/' }), revision: 2, create_time: T0 - 10 });
    expect(message.revisionId).toBe('2');
    expect(message.target).toBe('https://example.org/');
    expect(message.etag).toBe('0123456789abcdef');
  });
});
