import { ContentError } from "./errors";

const FIXED_PUBLIC_ROUTES = new Set([
  "/",
  "/blog",
  "/publications",
  "/feed.xml",
  "/sitemap.xml",
  "/robots.txt",
  "/build-info.json",
  "/publication-state.json",
  "/cv.pdf",
]);

const RESERVED_PUBLIC_NAMESPACES = ["/_next", "/media", "/profile", "/fonts"] as const;

/**
 * Next treats redirect sources as path-to-regexp patterns. Content redirects do
 * not need that power: accepting matcher syntax here would let a single content
 * record capture routes that were never reviewed. Keep this boundary literal.
 */
export function validateLiteralRedirectSource(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw invalidSource(value, "must start with exactly one slash");
  }
  if (value.includes("\\")) {
    throw invalidSource(value, "cannot contain backslashes");
  }
  if (value.includes("%")) {
    throw invalidSource(value, "cannot contain percent-encoded bytes");
  }
  if (/[?#]/u.test(value)) {
    throw invalidSource(value, "cannot contain a query or fragment");
  }
  if (/[:*+()[\]{}]/u.test(value)) {
    throw invalidSource(value, "cannot contain Next.js matcher syntax");
  }
  if (/\s|[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidSource(value, "cannot contain whitespace or control characters");
  }
  if (value.includes("//")) {
    throw invalidSource(value, "cannot contain empty path segments");
  }
  if (value.length > 1 && value.endsWith("/")) {
    throw invalidSource(value, "must not have a trailing slash");
  }
  if (value !== value.normalize("NFC")) {
    throw invalidSource(value, "must use NFC-normalized Unicode");
  }

  const segments = value.slice(1).split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw invalidSource(value, "cannot contain dot segments");
  }

  let canonicalPath: string;
  try {
    canonicalPath = decodeURI(new URL(value, "https://internal.invalid").pathname);
  } catch {
    throw invalidSource(value, "is not a valid URL path");
  }
  if (canonicalPath !== value) {
    throw invalidSource(value, "is not in canonical path form");
  }

  assertNotFixedPublicRoute(value);
  return value;
}

export function assertRedirectSourceDoesNotShadow(
  source: string,
  currentContentPaths: ReadonlySet<string>,
): void {
  validateLiteralRedirectSource(source);
  if (currentContentPaths.has(source)) {
    throw new ContentError(
      "REDIRECT_SHADOWS_ROUTE",
      `Redirect source shadows a public route: ${source}`,
    );
  }
}

function assertNotFixedPublicRoute(value: string): void {
  if (FIXED_PUBLIC_ROUTES.has(value)) {
    throw new ContentError(
      "REDIRECT_SHADOWS_ROUTE",
      `Redirect source shadows a public route: ${value}`,
    );
  }
  const namespace = RESERVED_PUBLIC_NAMESPACES.find(
    (prefix) => value === prefix || value.startsWith(`${prefix}/`),
  );
  if (namespace) {
    throw new ContentError(
      "REDIRECT_SHADOWS_NAMESPACE",
      `Redirect source shadows the reserved ${namespace} namespace: ${value}`,
    );
  }
}

function invalidSource(value: string, reason: string): ContentError {
  return new ContentError(
    "INVALID_REDIRECT_SOURCE",
    `Redirect source must be a normalized literal path and ${reason}: ${JSON.stringify(value)}`,
    { value },
  );
}
