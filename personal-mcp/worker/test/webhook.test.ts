import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Webhook } from 'standardwebhooks';
import { postSigned, validateCallback, verifyCallback } from '../src/webhook.ts';

const secret = `whsec_${btoa('s'.repeat(32))}`;
const callback = { id: 'sub_test', url: 'https://chatgpt.example.org/callback', secret };

describe('ChatGPT webhook', () => {
  it('accepts the native Dots callback with the production allowlist', () => {
    const config = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8');
    const hosts = /^CALLBACK_HOSTS\s*=\s*"([^"]+)"/m.exec(config)?.[1] ?? '';
    expect(() => { validateCallback('https://connectors.api.openai.com/synthetic-callback', secret, hosts); }).not.toThrow();
  });

  it('restricts callbacks to the configured HTTPS host', () => {
    expect(() => { validateCallback(callback.url, secret, 'chatgpt.example.org'); }).not.toThrow();
    expect(() => { validateCallback('http://chatgpt.example.org/callback', secret, 'chatgpt.example.org'); }).toThrow();
    expect(() => { validateCallback('https://other.example.org/callback', secret, 'chatgpt.example.org'); }).toThrow('configuration');
    expect(() => { validateCallback(callback.url, 'whsec_eA==', 'chatgpt.example.org'); }).toThrow('signing secret');
  });

  it('signs the exact body and verifies the callback challenge', async () => {
    const messages: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      if (typeof init.body !== 'string') throw new Error('Expected serialized JSON');
      const verified = new Webhook(secret).verify(init.body, Object.fromEntries(headers));
      messages.push(verified);
      expect(init.redirect).toBe('manual');
      expect(headers.get('x-mcp-subscription-id')).toBe(callback.id);
      return Promise.resolve(Response.json(verified));
    }));
    await postSigned(callback, 'event_test', JSON.stringify({ message: 'synthetic' }));
    await verifyCallback(callback);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ type: 'verification' });
  });

  it('does not accept a mismatching challenge', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({ challenge: 'wrong' }))));
    await expect(verifyCallback(callback)).rejects.toMatchObject({ code: -32015, data: { reason: 'challenge_failed' } });
  });
});
