import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { siteConfig } from "@content/site.config";
import { PublicationStateSchema } from "@/lib/content/publication-state";

import {
  assertEquivalentCanonical,
  assertFixtureDeploymentPolicy,
  assertRscResponse,
  makeRscRequestPath,
} from "../support/deployment-contract";

interface BuildInfo {
  codeSha: string;
  configHash: string;
  contentHash: string;
  schemaVersion: number;
}

interface ManifestRoute {
  expectedStatus: number;
  expectedLocation?: string;
  kind: "absent" | "asset" | "feed" | "page" | "post" | "redirect";
  mimeType?: string;
  path: string;
  sha256?: string;
  sizeBytes?: number;
}

interface DeploymentContract {
  canonicalOrigin: string;
  emptyStateText: string;
  routes: ManifestRoute[];
  sourceMode: "empty" | "fixture" | "notion";
}

const baseUrl = process.env.DEPLOYMENT_BASE_URL?.replace(/\/$/, "");
const authMode = process.env.DEPLOYMENT_AUTH_MODE;
const expectedBuildInfoPath = process.env.EXPECTED_BUILD_INFO_PATH;
const deploymentContractPath = process.env.DEPLOYMENT_CONTRACT_PATH;

if (process.env.DEPLOYMENT_TEST_REQUIRED && !baseUrl) {
  throw new Error("DEPLOYMENT_BASE_URL is required by the deployment-test entrypoint.");
}

test.describe("deployed artifact", () => {
  test.skip(!baseUrl, "DEPLOYMENT_BASE_URL is set only by the trusted release verifier.");

  test.beforeAll(() => {
    expect(authMode).toMatch(/^(candidate|production)$/);
    expect(expectedBuildInfoPath).toBeTruthy();
    if (authMode === "candidate") {
      expect(process.env.VERCEL_AUTOMATION_BYPASS_SECRET).toBeTruthy();
    } else {
      expect(process.env.VERCEL_AUTOMATION_BYPASS_SECRET).toBeUndefined();
    }
  });

  test("serves the expected build identity and every recorded route", async ({ request }) => {
    const [expected, contract] = await Promise.all([
      readJson<BuildInfo>(requiredPath(expectedBuildInfoPath, "EXPECTED_BUILD_INFO_PATH")),
      readDeploymentContract(),
    ]);
    const buildInfoResponse = await deploymentGet(request, "/build-info.json");
    expect(buildInfoResponse.status()).toBe(200);
    expect(buildInfoResponse.headers()["cache-control"]).toContain("no-store");
    expect(await buildInfoResponse.json()).toEqual(expected);

    for (const route of contract.routes) {
      const response = await deploymentGet(request, route.path);
      expect(response.status(), `${route.path} (${route.kind})`).toBe(route.expectedStatus);
      const responseMediaType = response.headers()["content-type"]?.split(";", 1)[0]?.trim();
      if (route.kind === "redirect") {
        const location = response.headers().location;
        expect(location, `${route.path} redirect location`).toBeTruthy();
        const redirectUrl = new URL(location!, requiredValue(baseUrl, "DEPLOYMENT_BASE_URL"));
        expect(`${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`).toBe(
          route.expectedLocation,
        );
      }
      if (route.kind === "asset") {
        const bytes = await response.body();
        expect(bytes.byteLength, `${route.path} byte length`).toBe(route.sizeBytes);
        expect(createHash("sha256").update(bytes).digest("hex"), `${route.path} hash`).toBe(
          route.sha256,
        );
        expect(response.headers()["content-type"]?.split(";", 1)[0]).toBe(route.mimeType);
      } else if (route.kind !== "redirect") {
        const body = await response.text();
        assertNoPrivateSourceMaterial(body);
        if (route.kind === "feed") {
          expect(response.headers()["content-type"]).toContain("application/rss+xml");
          expect(body).toContain('<rss version="2.0"');
          expect(body).toContain(`<link>${contract.canonicalOrigin}</link>`);
          expect(body).toContain(`${contract.canonicalOrigin}/feed.xml`);
        } else if (route.path === "/sitemap.xml") {
          expect(response.headers()["content-type"]).toContain("application/xml");
          expect(body).toContain(`<loc>${contract.canonicalOrigin}/</loc>`);
        } else if (route.path === "/robots.txt") {
          expect(body).toContain(`Sitemap: ${contract.canonicalOrigin}/sitemap.xml`);
        } else if (route.path === "/publication-state.json") {
          expect(responseMediaType).toBe("application/json");
          expect(response.headers()["cache-control"]).toContain("no-store");
          const state = PublicationStateSchema.parse(JSON.parse(body) as unknown);
          expect(state.identity).toEqual(expected);
          expect(state.posts.map((post) => `/blog/${post.slug}`).sort()).toEqual(
            contract.routes
              .filter((entry) => entry.kind === "post")
              .map((entry) => entry.path)
              .sort(),
          );
        }
      }

      if (route.kind === "post") {
        expect(responseMediaType, `${route.path} post media type`).toBe("text/html");
      }
      if (route.kind === "post" || (route.kind === "page" && responseMediaType === "text/html")) {
        const rscPath = makeRscRequestPath(route.path);
        const rsc = await deploymentGet(request, rscPath, { RSC: "1" });
        try {
          assertRscResponse({
            contentType: rsc.headers()["content-type"],
            requestUrl: new URL(rscPath, requiredValue(baseUrl, "DEPLOYMENT_BASE_URL")).href,
            responseUrl: rsc.url(),
            status: rsc.status(),
          });
        } catch (error) {
          throw new Error(`${route.path} RSC contract failed`, { cause: error });
        }
        assertNoPrivateSourceMaterial(await rsc.text());
      }
    }

    const missing = await deploymentGet(request, "/deployment-check-missing-page");
    expect(missing.status()).toBe(404);
  });

  test("renders canonical pages without leaking release credentials", async ({ page }) => {
    await installOriginScopedBypass(page);
    const contract = await readDeploymentContract();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    for (const pathname of ["/", "/blog", "/publications"] as const) {
      const response = await page.goto(pathname, { waitUntil: "networkidle" });
      expect(response?.status(), pathname).toBe(200);
      const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
      expect(canonical, `${pathname} canonical`).toBeTruthy();
      assertEquivalentCanonical(canonical!, new URL(pathname, contract.canonicalOrigin).toString());
      await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("NOTION_TOKEN");
      await assertNoSecretInHtml(page);
    }

    assertFixtureDeploymentPolicy({
      allowFixture: process.env.ALLOW_FIXTURE_DEPLOYMENT_TESTS === "true",
      authMode,
      baseUrl: requiredValue(baseUrl, "DEPLOYMENT_BASE_URL"),
      bypassSecret: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      sourceMode: contract.sourceMode,
    });
    await page.goto("/blog", { waitUntil: "networkidle" });
    const representativePost = contract.routes.find((route) => route.kind === "post");
    if (!representativePost) {
      await expect(page.getByText(contract.emptyStateText, { exact: true })).toBeVisible();
    } else {
      await page.goto(representativePost.path, { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator("article")).toBeVisible();
      const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
      expect(canonical, `${representativePost.path} canonical`).toBeTruthy();
      assertEquivalentCanonical(
        canonical!,
        new URL(representativePost.path, contract.canonicalOrigin).toString(),
      );
      await assertNoSecretInHtml(page);
    }

    expect(consoleErrors).toEqual([]);
  });
});

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, "utf8")) as T;
}

async function readDeploymentContract(): Promise<DeploymentContract> {
  if (deploymentContractPath) {
    return readJson<DeploymentContract>(
      requiredPath(deploymentContractPath, "DEPLOYMENT_CONTRACT_PATH"),
    );
  }
  const manifest = await readJson<Pick<DeploymentContract, "routes" | "sourceMode">>(
    path.join(process.cwd(), ".generated", "content", "manifest.json"),
  );
  return {
    ...manifest,
    canonicalOrigin: siteConfig.canonicalOrigin,
    emptyStateText: "Writing will appear here.",
  };
}

function requiredPath(value: string | undefined, name: string): string {
  return path.resolve(requiredValue(value, name));
}

function requiredValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function candidateHeaders(): Record<string, string> {
  if (authMode !== "candidate") return {};
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret) throw new Error("Candidate verification requires the automation bypass secret.");
  return { "x-vercel-protection-bypass": secret };
}

async function deploymentGet(
  request: APIRequestContext,
  pathname: string,
  additionalHeaders: Record<string, string> = {},
) {
  return request.get(pathname, {
    headers: { ...candidateHeaders(), ...additionalHeaders },
    // Never forward a protection-bypass secret through an unexpected redirect.
    // Every route has an exact expected status, so redirects are observed rather
    // than followed.
    maxRedirects: 0,
  });
}

async function installOriginScopedBypass(page: Page): Promise<void> {
  if (authMode !== "candidate") return;
  const expectedOrigin = new URL(requiredValue(baseUrl, "DEPLOYMENT_BASE_URL")).origin;
  const headers = candidateHeaders();
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== expectedOrigin) {
      await route.continue();
      return;
    }
    await route.continue({ headers: { ...route.request().headers(), ...headers } });
  });
}

async function assertNoSecretInHtml(page: Page): Promise<void> {
  assertNoPrivateSourceMaterial(await page.content());
}

function assertNoPrivateSourceMaterial(text: string): void {
  const sensitiveValues = [
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
    process.env.NOTION_TOKEN,
    process.env.NOTION_DATA_SOURCE_ID,
  ].filter((value): value is string => Boolean(value));
  for (const value of sensitiveValues) expect(text).not.toContain(value);
  expect(text).not.toMatch(
    /https:\/\/[^\s"'<>]*(?:file\.notion\.so|notion-static\.com|amazonaws\.com)/i,
  );
  expect(text).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
}
