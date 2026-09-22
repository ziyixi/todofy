import { ContentError } from "./errors";

export function validateHttpsOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ContentError("INVALID_ORIGIN", `Invalid canonical origin: ${value}`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ContentError(
      "INVALID_ORIGIN",
      "Canonical origin must be an HTTPS origin without credentials, path, query, or fragment.",
      { value },
    );
  }
  return parsed.origin;
}

export function validatePublicHref(value: string): string {
  if (value.startsWith("/")) {
    if (value.startsWith("//") || value.includes("\\") || /%(?:2f|5c)/i.test(value)) {
      throw new ContentError("INVALID_URL", `Ambiguous internal URL: ${value}`, { value });
    }
    const parsed = new URL(value, "https://internal.invalid");
    if (parsed.origin !== "https://internal.invalid") {
      throw new ContentError("INVALID_URL", `Invalid internal URL: ${value}`, { value });
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ContentError("INVALID_URL", `Invalid link URL: ${value}`, { value });
  }
  // Navigational links are not server-side fetches. Media downloads and the
  // canonical origin enforce HTTPS separately; preserve authors' HTTP links.
  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "mailto:"
  ) {
    throw new ContentError("UNSAFE_URL", `Unsupported link protocol: ${parsed.protocol}`, {
      value,
    });
  }
  if (parsed.username || parsed.password) {
    throw new ContentError("UNSAFE_URL", "Links cannot contain credentials.", { value });
  }
  return parsed.toString();
}

export function postPath(slug: string): string {
  return `/blog/${slug}`;
}
