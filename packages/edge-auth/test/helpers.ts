/**
 * Test fixtures: RSA keys and Access-style JWTs minted with Web Crypto (an implementation independent
 * of the package's decoder), a fake certs endpoint, and each app's policy exactly as SPEC.md §5.4
 * passes it.
 */
import { vi } from 'vitest';
import type { AccessPolicy } from '../src/index.ts';

export const ISSUER = 'https://team-name.cloudflareaccess.com';
export const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
export const AUDIENCE = 'aud-1';
/** 2026-09-29T12:00:00Z; every test runs on a frozen clock. */
export const NOW = 1_790_683_200;

export const MAIL_HERO_OWNER = 'owner@example.org';
export const MAIL_HERO_ALIAS = 'github-owner@example.net';
export const TODOFY_OWNER = 'owner@example.com';
export const TODOFY_ALIAS = 'owner.alias@example.net';

const RSA = (modulusLength: number) => ({
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
});

export async function rsaPair(bits = 2048): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(RSA(bits), true, ['sign', 'verify'])) as CryptoKeyPair;
}

export async function publicJwk(pair: CryptoKeyPair, kid: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as unknown as Record<string, unknown>;
  // What Access publishes: {kid, kty, alg, use, e, n}; exportKey also adds key_ops and ext.
  return { ...jwk, kid, alg: 'RS256', use: 'sig', ...extra };
}

export function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const text = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(value));
export const encodeJson = (value: unknown): string => b64url(text(JSON.stringify(value)));

export interface JwtOptions {
  readonly key: CryptoKeyPair;
  readonly header?: Record<string, unknown>;
  readonly claims?: Record<string, unknown>;
  /** Raw payload JSON text instead of `claims` (for values JSON.stringify cannot write, like 1e999). */
  readonly rawPayload?: string;
}

/** Access-shaped claims issued at the (frozen) current time. */
export function baseClaims(email = TODOFY_OWNER): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: ISSUER, aud: [AUDIENCE], email, sub: 'owner-id', iat: now, exp: now + 600, nbf: now };
}

/** An RS256 JWT; `undefined` values in header/claims remove that member. */
export async function mintJwt({ key, header = {}, claims = {}, rawPayload }: JwtOptions): Promise<string> {
  const headerPart = encodeJson({ alg: 'RS256', kid: 'key-1', typ: 'JWT', ...header });
  const payloadPart = rawPayload === undefined ? encodeJson({ ...baseClaims(), ...claims }) : b64url(text(rawPayload));
  return signJwt(key, `${headerPart}.${payloadPart}`);
}

export async function signJwt(key: CryptoKeyPair, signingInput: string): Promise<string> {
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, text(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

export type CertsFetch = ReturnType<typeof certsEndpoint>;

/** A fake certs endpoint serving `{keys: current()}`; override one answer with mockImplementationOnce. */
export function certsEndpoint(current: () => unknown[]) {
  return vi.fn((url: string, init: RequestInit): Promise<Response> => {
    void url;
    void init;
    return Promise.resolve(Response.json({ keys: current() }));
  });
}

export function get(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

export const withToken = (jwt: string, url = 'https://mail.example.org/api/v1/overview', extra: Record<string, string> = {}): Request =>
  get(url, { 'cf-access-jwt-assertion': jwt, ...extra });

type Overrides = Partial<{ -readonly [K in keyof AccessPolicy]: AccessPolicy[K] }>;

/** Mail Hero's adapter (SPEC.md §5.4) with its env values filled in. */
export function mailHeroPolicy(overrides: Overrides = {}, env: { DEV_AUTH_BYPASS?: string } = {}): AccessPolicy {
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    owner: MAIL_HERO_OWNER,
    aliases: `${MAIL_HERO_ALIAS}, other@example.org`,
    emailMatch: 'exact',
    nbfLeewaySeconds: 0,
    tokenSource: { emptyHeader: 'missing', cookie: 'first' },
    jwks: { ttlMs: 600_000, refreshCooldownMs: 30_000 },
    devBypass: { enabled: env.DEV_AUTH_BYPASS === 'true', hosts: 'loopback-http', principal: 'local-development', whenNotLocal: 'refuse' },
    ...overrides,
  };
}

/** Todofy's adapter (SPEC.md §5.4); its test env writes the owner and aliases in mixed case. */
export function todofyPolicy(overrides: Overrides = {}, env: { localDev?: boolean; bypass?: boolean; loopback?: boolean } = {}): AccessPolicy {
  const owner = ' Owner@Example.com ';
  return {
    issuer: `${ISSUER}/`,
    audience: AUDIENCE,
    owner,
    aliases: `${TODOFY_ALIAS.toUpperCase()}, other.login@example.org`,
    emailMatch: 'case-insensitive',
    nbfLeewaySeconds: 60,
    tokenSource: { emptyHeader: 'use-cookie', cookie: 'last' },
    jwks: { ttlMs: 3_600_000, refreshCooldownMs: 60_000 },
    loopbackIssuer: env.localDev === true && env.loopback === true,
    devBypass: {
      enabled: env.localDev === true && env.bypass === true,
      hosts: 'dot-localhost',
      principal: owner.trim().toLowerCase(),
      whenNotLocal: 'verify',
    },
    ...overrides,
  };
}
