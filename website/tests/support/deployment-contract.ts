export interface RscResponseContract {
  contentType: string | undefined;
  requestUrl: string;
  responseUrl: string;
  status: number;
}

export interface FixtureDeploymentPolicy {
  allowFixture: boolean;
  authMode: string | undefined;
  baseUrl: string;
  bypassSecret: string | undefined;
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
  if (
    policy.authMode !== "production" ||
    policy.bypassSecret !== undefined ||
    !["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname)
  ) {
    throw new Error(
      "fixture deployment contracts are allowed only for an uncredentialed local production server",
    );
  }
}

export function makeRscRequestPath(pathname: string): string {
  const url = new URL(pathname, "https://deployment-contract.invalid");
  if (url.origin !== "https://deployment-contract.invalid" || url.hash) {
    throw new Error(`RSC route must be a root-relative URL without a fragment: ${pathname}`);
  }
  url.searchParams.delete("_rsc");
  url.searchParams.set("_rsc", "");
  return `${url.pathname}${url.search}`;
}

export function assertRscResponse(contract: RscResponseContract): void {
  if (contract.status !== 200) {
    throw new Error(`RSC response must be 200, received ${contract.status}`);
  }
  const mediaType = contract.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "text/x-component") {
    throw new Error(`RSC response must use text/x-component, received ${mediaType ?? "missing"}`);
  }
  const requestUrl = parseHttpUrl(contract.requestUrl, "RSC request URL");
  const responseUrl = parseHttpUrl(contract.responseUrl, "RSC response URL");
  if (
    requestUrl.origin !== responseUrl.origin ||
    requestUrl.pathname !== responseUrl.pathname ||
    requestUrl.search !== responseUrl.search ||
    requestUrl.hash !== responseUrl.hash
  ) {
    throw new Error(
      `RSC response changed origin or route: requested ${requestUrl.href}, received ${responseUrl.href}`,
    );
  }
}
