import { describe, expect, it } from "vitest";

import {
  assertEquivalentCanonical,
  assertFixtureDeploymentPolicy,
  assertRscResponse,
  makeRscRequestPath,
} from "../support/deployment-contract";

describe("fixture deployment-test boundary", () => {
  const localFixture = {
    allowFixture: true,
    authMode: "production",
    baseUrl: "http://127.0.0.1:4173",
    bypassSecret: undefined,
    sourceMode: "fixture" as const,
  };

  it("allows an explicit uncredentialed localhost fixture contract", () => {
    expect(() => assertFixtureDeploymentPolicy(localFixture)).not.toThrow();
  });

  it("rejects fixture content by default and in remote or credentialed modes", () => {
    expect(() => assertFixtureDeploymentPolicy({ ...localFixture, allowFixture: false })).toThrow(
      /explicit local-test opt-in/,
    );
    expect(() =>
      assertFixtureDeploymentPolicy({
        ...localFixture,
        baseUrl: "https://candidate.example.vercel.app",
      }),
    ).toThrow(/uncredentialed local production server/);
    expect(() =>
      assertFixtureDeploymentPolicy({ ...localFixture, bypassSecret: "secret" }),
    ).toThrow(/uncredentialed local production server/);
  });

  it("does not require the local opt-in for production content modes", () => {
    expect(() =>
      assertFixtureDeploymentPolicy({
        ...localFixture,
        allowFixture: false,
        baseUrl: "https://www.ziyixi.science",
        sourceMode: "notion",
      }),
    ).not.toThrow();
  });
});

describe("deployment canonical contract", () => {
  it("normalizes the root URL while preserving every semantic URL component", () => {
    expect(() =>
      assertEquivalentCanonical("https://www.ziyixi.science", "https://www.ziyixi.science/"),
    ).not.toThrow();
    expect(() =>
      assertEquivalentCanonical(
        "https://www.ziyixi.science/blog?view=all#top",
        "https://www.ziyixi.science/blog?view=all#top",
      ),
    ).not.toThrow();
  });

  it("rejects changed origins, paths, queries, and fragments", () => {
    for (const actual of [
      "https://example.com/blog?view=all#top",
      "https://www.ziyixi.science/publications?view=all#top",
      "https://www.ziyixi.science/blog?view=one#top",
      "https://www.ziyixi.science/blog?view=all#other",
    ]) {
      expect(() =>
        assertEquivalentCanonical(actual, "https://www.ziyixi.science/blog?view=all#top"),
      ).toThrow(/canonical URL mismatch/);
    }
  });
});

describe("RSC deployment contract", () => {
  it("constructs the fixed Next.js cache-busting query without dropping existing search", () => {
    expect(makeRscRequestPath("/")).toBe("/?_rsc=");
    expect(makeRscRequestPath("/blog?view=all")).toBe("/blog?view=all&_rsc=");
  });

  it("requires an exact 200 component response on the requested origin and route", () => {
    const valid = {
      contentType: "text/x-component; charset=utf-8",
      requestUrl: "https://www.ziyixi.science/blog?_rsc=",
      responseUrl: "https://www.ziyixi.science/blog?_rsc=",
      status: 200,
    };
    expect(() => assertRscResponse(valid)).not.toThrow();
    expect(() => assertRscResponse({ ...valid, status: 307 })).toThrow(/must be 200/);
    expect(() => assertRscResponse({ ...valid, contentType: "text/html" })).toThrow(
      /text\/x-component/,
    );
    expect(() =>
      assertRscResponse({
        ...valid,
        responseUrl: "https://attacker.example/blog?_rsc=",
      }),
    ).toThrow(/changed origin or route/);
    expect(() =>
      assertRscResponse({
        ...valid,
        responseUrl: "https://www.ziyixi.science/publications?_rsc=",
      }),
    ).toThrow(/changed origin or route/);
  });
});
