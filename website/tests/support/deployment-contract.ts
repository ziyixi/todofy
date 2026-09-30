export interface SegmentPayloadContract {
  contentType: string | undefined;
  requestUrl: string;
  responseUrl: string;
  status: number;
}

export interface FixtureDeploymentPolicy {
  allowFixture: boolean;
  baseUrl: string;
  sourceMode: "empty" | "fixture" | "notion";
}

function parseHttpUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not an absolute URL: ${value}`);
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials: ${value}`);
  }
  return parsed;
}

export function assertEquivalentCanonical(actual: string, expected: string): void {
  const actualUrl = parseHttpUrl(actual, "canonical URL");
  const expectedUrl = parseHttpUrl(expected, "expected canonical URL");
  const actualParts = [actualUrl.origin, actualUrl.pathname, actualUrl.search, actualUrl.hash];
  const expectedParts = [
    expectedUrl.origin,
    expectedUrl.pathname,
    expectedUrl.search,
    expectedUrl.hash,
  ];
  if (actualParts.some((part, index) => part !== expectedParts[index])) {
    throw new Error(
      `canonical URL mismatch: expected ${expectedUrl.href}, received ${actualUrl.href}`,
    );
  }
}

export function assertFixtureDeploymentPolicy(policy: FixtureDeploymentPolicy): void {
  if (policy.sourceMode !== "fixture") return;
  if (!policy.allowFixture) {
    throw new Error("fixture deployment contracts require an explicit local-test opt-in");
  }
  const baseUrl = parseHttpUrl(policy.baseUrl, "fixture deployment base URL");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname)) {
    throw new Error("fixture deployment contracts are allowed only for a local server");
  }
}

/**
 * The static export stores each route's React Server Component payloads as files next to its HTML
 * (Next 16 segment prefetching): `<route>/__next._tree.txt` is requested before every client-side
 * navigation to that route. The old `?_rsc=` + `RSC: 1` contract belonged to a Next.js server.
 */
export function makeSegmentTreePath(pathname: string): string {
  const url = new URL(pathname, "https://deployment-contract.invalid");
  if (url.origin !== "https://deployment-contract.invalid" || url.hash || url.search) {
    throw new Error(`Route must be a root-relative path without query or fragment: ${pathname}`);
  }
  const base = url.pathname.replace(/\/+$/, "");
  return `${base}/__next._tree.txt`;
}

export function assertSegmentPayloadResponse(contract: SegmentPayloadContract): void {
  if (contract.status !== 200) {
    throw new Error(`Segment payload must be 200, received ${contract.status}`);
  }
  const mediaType = contract.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "text/plain") {
    throw new Error(`Segment payload must use text/plain, received ${mediaType ?? "missing"}`);
  }
  const requestUrl = parseHttpUrl(contract.requestUrl, "segment payload request URL");
  const responseUrl = parseHttpUrl(contract.responseUrl, "segment payload response URL");
  if (
    requestUrl.origin !== responseUrl.origin ||
    requestUrl.pathname !== responseUrl.pathname ||
    requestUrl.search !== responseUrl.search
  ) {
    throw new Error(
      `Segment payload changed origin or route: requested ${requestUrl.href}, received ${responseUrl.href}`,
    );
  }
}
