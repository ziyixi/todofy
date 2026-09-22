import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import { ContentError } from "../../../src/lib/content/errors";
import type { MediaAsset } from "../types";
import type { RemoteImage, ResolvedImage } from "./types";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const DEFAULT_ALLOWED_HOST_SUFFIXES = ["amazonaws.com", "file.notion.so", "notion-static.com"];

export interface MediaResolverOptions {
  publicDirectory: string;
  allowedHostSuffixes?: string[];
  maxImageBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
  refreshUrl?: (notionBlockId: string) => Promise<string>;
}

export interface LimitedBodyOptions {
  maxImageBytes: number;
  maxTotalRemainingBytes: number;
  notionBlockId: string;
}

export interface FetchRetryOptions {
  timeoutMs: number;
  maxAttempts?: number;
  maxRetryDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
}

export type MediaResponseFetcher = (url: string) => Promise<Response>;

export function createMediaResolver(options: MediaResolverOptions) {
  const allowedHostSuffixes = options.allowedHostSuffixes ?? DEFAULT_ALLOWED_HOST_SUFFIXES;
  const maxImageBytes = options.maxImageBytes ?? 20 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 200 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const mediaDirectory = path.join(options.publicDirectory, "media");
  let totalBytes = 0;

  return async function resolveImage(image: RemoteImage): Promise<ResolvedImage> {
    const response = await fetchMediaWithUrlRefresh(image, options.refreshUrl, (url) =>
      safeFetch(url, allowedHostSuffixes, timeoutMs),
    );
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!mimeType || !MIME_EXTENSIONS[mimeType]) {
      throw new ContentError(
        "UNSUPPORTED_MEDIA_TYPE",
        `Image block ${image.notionBlockId} returned unsupported media type ${mimeType ?? "unknown"}.`,
      );
    }
    const contentLength = response.headers.get("content-length");
    const declaredSize = contentLength === null ? undefined : Number(contentLength);
    if (
      declaredSize !== undefined &&
      Number.isFinite(declaredSize) &&
      declaredSize > maxImageBytes
    ) {
      throw new ContentError(
        "MEDIA_TOO_LARGE",
        `Image block ${image.notionBlockId} exceeds the ${maxImageBytes}-byte limit.`,
      );
    }
    const remainingTotalBytes = maxTotalBytes - totalBytes;
    if (
      declaredSize !== undefined &&
      Number.isFinite(declaredSize) &&
      declaredSize > remainingTotalBytes
    ) {
      throw new ContentError(
        "MEDIA_TOTAL_TOO_LARGE",
        `Downloaded media exceeds the ${maxTotalBytes}-byte total limit.`,
      );
    }

    const bytes = await readLimitedResponseBody(response, {
      maxImageBytes,
      maxTotalRemainingBytes: remainingTotalBytes,
      notionBlockId: image.notionBlockId,
    });
    totalBytes += bytes.byteLength;

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const extension = MIME_EXTENSIONS[mimeType];
    const filename = `${sha256}.${extension}`;
    const diskPath = path.join(mediaDirectory, filename);
    await mkdir(mediaDirectory, { recursive: true });
    await writeContentAddressedFile(diskPath, bytes, sha256);

    const sharpModule = await import("sharp");
    const metadata = await sharpModule.default(bytes, { animated: true }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new ContentError(
        "INVALID_IMAGE",
        `Image block ${image.notionBlockId} has no readable dimensions.`,
      );
    }

    const asset: MediaAsset = {
      path: `/media/${filename}`,
      sha256,
      mimeType,
      sizeBytes: bytes.byteLength,
      width: metadata.width,
      height: metadata.height,
    };
    return { asset };
  };
}

/**
 * Notion file URLs are short lived. Refresh exactly once when the original URL
 * is rejected as expired, while preserving every other download failure.
 */
export async function fetchMediaWithUrlRefresh(
  image: RemoteImage,
  refreshUrl: MediaResolverOptions["refreshUrl"],
  fetchResponse: MediaResponseFetcher,
): Promise<Response> {
  try {
    return await fetchResponse(image.url);
  } catch (error) {
    const status =
      error instanceof ContentError && typeof error.details?.status === "number"
        ? error.details.status
        : undefined;
    if (!refreshUrl || (status !== 401 && status !== 403)) throw error;
    return fetchResponse(await refreshUrl(image.notionBlockId));
  }
}

/**
 * Reads a response incrementally so a missing or dishonest Content-Length cannot
 * make the synchronizer buffer an unbounded image. The reader is cancelled as
 * soon as either limit is crossed.
 */
export async function readLimitedResponseBody(
  response: Response,
  options: LimitedBodyOptions,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      byteLength += chunk.byteLength;

      let limitError: ContentError | undefined;
      if (byteLength > options.maxImageBytes) {
        limitError = new ContentError(
          "MEDIA_TOO_LARGE",
          `Image block ${options.notionBlockId} exceeds the ${options.maxImageBytes}-byte limit.`,
        );
      } else if (byteLength > options.maxTotalRemainingBytes) {
        limitError = new ContentError(
          "MEDIA_TOTAL_TOO_LARGE",
          "Downloaded media exceeds the total media limit.",
        );
      }
      if (limitError) {
        try {
          await reader.cancel(limitError);
        } catch {
          // Preserve the limit error even if the remote stream rejects cancellation.
        }
        throw limitError;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function safeFetch(
  rawUrl: string,
  allowedHostSuffixes: string[],
  timeoutMs: number,
): Promise<Response> {
  let currentUrl = rawUrl;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const parsed = await validateRemoteUrl(currentUrl, allowedHostSuffixes);
    const response = await fetchWithRetry(parsed, { timeoutMs });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location)
        throw new ContentError("INVALID_MEDIA_REDIRECT", "Media redirect has no target.");
      currentUrl = new URL(location, parsed).toString();
      continue;
    }
    if (!response.ok) {
      throw new ContentError(
        "MEDIA_DOWNLOAD_FAILED",
        `Media host ${parsed.hostname} returned HTTP ${response.status}.`,
        { status: response.status },
      );
    }
    return response;
  }
  throw new ContentError("MEDIA_REDIRECT_LIMIT", "Media download exceeded three redirects.");
}

/** Retries only explicit throttling and transient server responses. */
export async function fetchWithRetry(url: URL, options: FetchRetryOptions): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 3;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 5_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  let lastNetworkError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: { "user-agent": "ziyixi-content-sync/1" },
      });
    } catch (error) {
      lastNetworkError = error;
      if (attempt === maxAttempts - 1) break;
      await sleep(Math.min(250 * 2 ** attempt, maxRetryDelayMs));
      continue;
    }
    const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
    if (!retryable || attempt === maxAttempts - 1) return response;

    try {
      await response.body?.cancel();
    } catch {
      // The retry decision is based on the status; a failed body cancellation
      // must not hide a later successful attempt.
    }
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    const backoff = 250 * 2 ** attempt;
    await sleep(Math.min(retryAfter ?? backoff, maxRetryDelayMs));
  }

  throw new ContentError(
    "MEDIA_DOWNLOAD_FAILED",
    `Media network request failed after ${maxAttempts} attempts.`,
    {
      cause:
        lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError),
    },
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - Date.now());
}

async function validateRemoteUrl(rawUrl: string, allowedHostSuffixes: string[]): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ContentError("INVALID_MEDIA_URL", "Media URL is invalid.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new ContentError("UNSAFE_MEDIA_URL", "Media URLs must use HTTPS without credentials.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !allowedHostSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))
  ) {
    throw new ContentError("MEDIA_HOST_NOT_ALLOWED", `Media host is not allowed: ${hostname}`);
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new ContentError(
      "UNSAFE_MEDIA_ADDRESS",
      `Media host resolves to a private address: ${hostname}`,
    );
  }
  return parsed;
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const a = parts[0] ?? -1;
    const b = parts[1] ?? -1;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  return true;
}

async function writeContentAddressedFile(
  diskPath: string,
  bytes: Uint8Array,
  expectedHash: string,
): Promise<void> {
  try {
    const existing = await readFile(diskPath);
    const actual = createHash("sha256").update(existing).digest("hex");
    if (actual === expectedHash) return;
    throw new ContentError(
      "MEDIA_HASH_COLLISION",
      "Existing content-addressed media has a wrong hash.",
    );
  } catch (error) {
    if (error instanceof ContentError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  const temporary = `${diskPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, diskPath);
}
