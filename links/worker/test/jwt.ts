/**
 * A synthetic Cloudflare Access issuer for tests: an RS256 key pair made with Web Crypto, its JWKS
 * (what `<issuer>/cdn-cgi/access/certs` serves) and signed tokens. Used by the workerd suite.
 */

/** The JWK members Access publishes (and edge-auth reads). */
export interface Jwk {
  readonly kty: string;
  readonly n?: string | undefined;
  readonly e?: string | undefined;
  readonly kid: string;
  readonly alg: string;
  readonly use: string;
}

export interface TestIssuer {
  readonly jwks: { keys: Jwk[] };
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const segment = (value: unknown): string => base64Url(encoder.encode(JSON.stringify(value)));

export async function testIssuer(kid = 'synthetic-kid-1'): Promise<TestIssuer> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { n?: string; e?: string };
  return {
    jwks: { keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, kid, alg: 'RS256', use: 'sig' }] },
    async sign(claims, header = {}) {
      const signed = `${segment({ alg: 'RS256', kid, typ: 'JWT', ...header })}.${segment(claims)}`;
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, encoder.encode(signed));
      return `${signed}.${base64Url(new Uint8Array(signature))}`;
    },
  };
}

/** Claims of a valid Access login of `email` for `issuer`/`audience`, valid for an hour. */
export function accessClaims(issuer: string, audience: string, email: string, nowSeconds = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  return { iss: issuer, aud: [audience], sub: 'synthetic-user-id', email, iat: nowSeconds - 10, nbf: nowSeconds - 10, exp: nowSeconds + 3600 };
}
