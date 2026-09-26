import { afterEach, describe, expect, it, vi } from "vitest";

import { hashContentSnapshot, sha256 } from "../../src/lib/content/hash";
import { PublicationStateSchema } from "../../src/lib/content/publication-state";
import { CONTENT_SCHEMA_VERSION, type ContentSnapshot } from "../../src/lib/content/schema";

const { getContentBundle } = vi.hoisted(() => ({ getContentBundle: vi.fn() }));

vi.mock("@/app/_site-data", () => ({
  getContentBundle,
  getSiteData: vi.fn(async () => ({})),
}));

import { GET as getBuildInfo } from "../../src/app/build-info.json/route";
import {
  dynamic,
  GET as getPublicationState,
  revalidate,
} from "../../src/app/publication-state.json/route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("publication-state.json", () => {
  it("uses the same manifest and code identity as build-info.json with a no-store response", async () => {
    const sourceKey = sha256("public-article");
    const snapshot: ContentSnapshot = {
      schemaVersion: CONTENT_SCHEMA_VERSION,
      sourceMode: "fixture",
      posts: [
        {
          sourceKey,
          feedGuid: `urn:ziyixi:post:${sourceKey}`,
          slug: "public-article",
          title: "A public article",
          summary: "A public summary.",
          language: "en",
          publishedAt: "2026-01-01T00:00:00.000Z",
          tags: [],
          blocks: [],
          toc: [],
          media: [],
        },
      ],
      media: [],
      redirects: [],
    };
    const contentHash = hashContentSnapshot(snapshot);
    getContentBundle.mockResolvedValue({
      snapshot,
      manifest: {
        contentHash,
        configHash: sha256("config"),
        schemaVersion: CONTENT_SCHEMA_VERSION,
      },
    });
    vi.stubEnv("CODE_SHA", "a".repeat(40));
    vi.stubEnv("GITHUB_SHA", "b".repeat(40));

    const [buildInfo, response] = await Promise.all([getBuildInfo(), getPublicationState()]);
    const state = PublicationStateSchema.parse(await response.json());
    expect(state.identity).toEqual(await buildInfo.json());
    expect(state.identity).toMatchObject({ codeSha: "a".repeat(40), contentHash });
    expect(state.posts).toHaveLength(1);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(dynamic).toBe("force-static");
    expect(revalidate).toBe(false);
  });
});
