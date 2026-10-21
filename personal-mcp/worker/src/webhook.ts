import { constantTimeEqual } from '@ziyixi/edge-auth';
import { ProtocolError } from '@modelcontextprotocol/server';
import { Webhook } from 'standardwebhooks';

export interface Callback {
  id: string;
  url: string;
  secret: string;
}

export function validateCallback(url: string, secret: string, allowedHosts: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) {
    throw new ProtocolError(-32602, 'Callback must be HTTPS.');
  }
  if (!allowedHosts.split(',').map(host => host.trim()).filter(Boolean).includes(parsed.hostname)) {
    // Hostname only: the full callback URL and signing secret are credentials.
    throw new ProtocolError(-32015, 'ChatGPT callback host needs configuration.', {
      reason: 'callback_host_unapproved', hostname: parsed.hostname,
    });
  }
  if (!secret.startsWith('whsec_')) throw new ProtocolError(-32602, 'Invalid callback signing secret.');
  let bytes: number;
  try { bytes = atob(secret.slice(6)).length; }
  catch { throw new ProtocolError(-32602, 'Invalid callback signing secret.'); }
  if (bytes < 24 || bytes > 64) throw new ProtocolError(-32602, 'Invalid callback signing secret.');
}

export async function postSigned(callback: Callback, id: string, body: string): Promise<Response> {
  const signedAt = new Date();
  const signer = new Webhook(callback.secret);
  return fetch(callback.url, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
    headers: {
      'Content-Type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(signedAt.getTime() / 1000)),
      'webhook-signature': signer.sign(id, signedAt, body),
      'X-MCP-Subscription-Id': callback.id,
    },
    body,
  });
}

export async function verifyCallback(callback: Callback): Promise<void> {
  const challenge = crypto.randomUUID();
  try {
    const response = await postSigned(callback, `verification_${crypto.randomUUID()}`, JSON.stringify({ type: 'verification', challenge }));
    const reply: unknown = response.ok ? await response.json() : null;
    if (typeof reply === 'object' && reply !== null && 'challenge' in reply
      && typeof reply.challenge === 'string' && constantTimeEqual(reply.challenge, challenge)) return;
  } catch {
    throw new ProtocolError(-32015, 'Callback verification failed.', { reason: 'unreachable_or_timeout' });
  }
  throw new ProtocolError(-32015, 'Callback verification failed.', { reason: 'challenge_failed' });
}
