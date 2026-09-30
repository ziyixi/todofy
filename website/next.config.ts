import { readFile } from "node:fs/promises";
import path from "node:path";

import type { NextConfig } from "next";

import { validateLiteralRedirectSource } from "./src/lib/content/redirect-path";

interface PreparedRedirect {
  from: string;
  to: string;
}

async function readPreparedRedirects(): Promise<PreparedRedirect[]> {
  const snapshotPath = path.join(process.cwd(), ".generated", "content", "snapshot.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(snapshotPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      "Prepared content is required before running Next.js. Run `pnpm content:prepare:empty` or `pnpm content:prepare:fixture` first.",
      { cause: error },
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("redirects" in parsed) ||
    !Array.isArray(parsed.redirects) ||
    !parsed.redirects.every(
      (redirect) =>
        typeof redirect === "object" &&
        redirect !== null &&
        "from" in redirect &&
        typeof redirect.from === "string" &&
        "to" in redirect &&
        typeof redirect.to === "string",
    )
  ) {
    throw new Error("Prepared content contains an invalid redirects collection.");
  }
  return (parsed.redirects as PreparedRedirect[]).map((redirect) => {
    const from = validateLiteralRedirectSource(redirect.from);
    if (!redirect.to.startsWith("/") || redirect.to.startsWith("//")) {
      throw new Error(`Prepared redirect target must be internal: ${redirect.to}`);
    }
    return { from, to: redirect.to };
  });
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  async redirects() {
    return (await readPreparedRedirects()).map((redirect) => ({
      source: redirect.from,
      destination: redirect.to,
      permanent: true,
    }));
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      {
        source: "/build-info.json",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
      {
        source: "/publication-state.json",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
    ];
  },
};

export default nextConfig;
