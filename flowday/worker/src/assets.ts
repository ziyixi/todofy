/**
 * The static UI (web/out, Next.js static export) behind the Worker: every request reaches the Worker first
 * (run_worker_first), which checks Access before handing a path to ASSETS, except for the exact PWA paths below.
 *
 * Headers: the private headers of every app (edge-auth). The page's Content-Security-Policy allows exactly the
 * inline scripts of the HTML being served, by SHA-256 hash (Next.js inlines its boot and RSC payload scripts;
 * nothing else inline may run). Hashed build files under /_next/static/ are cached as immutable.
 */
import { STRICT_CSP, withPrivateHeaders } from '@ziyixi/edge-auth';

const IMMUTABLE = 'private, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

/**
 * Paths served without an Access JWT (../../docs/design.md "PWA"). While the Access app "flowday-bypass" covers
 * /pwa/*, the browser fetches the manifest and icons without the Access cookie, and the service worker script must
 * load for an installed app to update. Exactly these paths, nothing else under /pwa/ and never /api.
 */
export const PWA_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/pwa/manifest.webmanifest',
  '/pwa/sw',
  '/pwa/icon-192x192.png',
  '/pwa/icon-512x512.png',
  '/pwa/icon-maskable-512x512.png',
  '/pwa/icon.svg',
  '/pwa/apple-touch-icon.png',
]);

/** The service worker keeps its container-era URL (/pwa/sw, scope /) so installed apps update in place. */
export const SERVICE_WORKER_PATH = '/pwa/sw';
const SERVICE_WORKER_ASSET = '/pwa/sw.js';

/** A public PWA file: the asset, with the service worker's scope header. */
export async function pwaAsset(request: Request, assets: Fetcher, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  if (pathname === SERVICE_WORKER_PATH) {
    url.pathname = SERVICE_WORKER_ASSET;
    const response = await assets.fetch(new Request(url, { method: request.method, headers: request.headers }));
    const copy = withPrivateHeaders(response, { cacheControl: REVALIDATE });
    if (response.ok) {
      copy.headers.set('content-type', 'application/javascript; charset=utf-8');
      copy.headers.set('service-worker-allowed', '/');
    }
    return copy;
  }
  const response = await assets.fetch(request);
  const copy = withPrivateHeaders(response, { cacheControl: REVALIDATE });
  if (pathname.endsWith('.webmanifest') && response.ok) copy.headers.set('content-type', 'application/manifest+json');
  return copy;
}

const INLINE_SCRIPT = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;

/** SHA-256 CSP sources ('sha256-…') of every inline script of an HTML document, in order, without duplicates. */
export async function inlineScriptHashes(html: string): Promise<string[]> {
  const hashes: string[] = [];
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const attributes = match[1] ?? '';
    if (/\ssrc\s*=/i.test(attributes)) continue;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[2] ?? ''));
    const source = `'sha256-${toBase64(new Uint8Array(digest))}'`;
    if (!hashes.includes(source)) hashes.push(source);
  }
  return hashes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** STRICT_CSP with these script hashes added to script-src. */
export function pageCsp(hashes: readonly string[]): string {
  if (hashes.length === 0) return STRICT_CSP;
  return STRICT_CSP.replace("script-src 'self'", `script-src 'self' ${hashes.join(' ')}`);
}

/** An authenticated GET or HEAD of the UI, with the private headers. */
export async function uiAsset(request: Request, assets: Fetcher, pathname: string): Promise<Response> {
  const response = await assets.fetch(request);
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType === 'text/html' && response.ok && request.method === 'GET') {
    const html = await response.text();
    const page = new Response(html, response);
    return withPrivateHeaders(page, { csp: pageCsp(await inlineScriptHashes(html)) });
  }
  const immutable = response.status === 200 && pathname.startsWith('/_next/static/');
  return withPrivateHeaders(response, immutable ? { cacheControl: IMMUTABLE } : {});
}
