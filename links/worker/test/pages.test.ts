import { describe, expect, it } from 'vitest';
import { escapeHtml, previewPage, refusalText, ROBOTS_TXT } from '../src/pages.ts';

describe('the preview page', () => {
  const row = { target: 'https://example.com/', description: '<script>alert(1)</script> & "x"', path_mode: 'exact', visibility: 'public', expire_time: null, delete_time: null } as const;

  it('escapes everything it shows and loads nothing', () => {
    const page = previewPage('gh', row, 'https://example.com/?a=1&b="2"');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;');
    expect(page).toContain('href="https://example.com/?a=1&amp;b=&quot;2&quot;"');
    expect(page).not.toMatch(/<script|<link|<img|src=/i);
    expect(page).toContain('Public link');
  });

  it('says when the path goes nowhere, and which links are private', () => {
    const page = previewPage('gh', { ...row, visibility: 'private', description: '' }, null);
    expect(page).toContain('does not lead anywhere');
    expect(page).toContain('Private link');
  });

  it('escapes the five HTML characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('has fixed refusal texts and a robots.txt that disallows everything', () => {
    expect(refusalText('NO_PATH')).toMatch(/no path/);
    expect(refusalText('BAD_PATH')).toMatch(/not allowed/);
    expect(ROBOTS_TXT).toBe('User-agent: *\nDisallow: /\n');
  });
});
