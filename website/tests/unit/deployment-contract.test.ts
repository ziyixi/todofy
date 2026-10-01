import { describe, expect, it } from "vitest";

import {
  assertEquivalentCanonical,
  assertFixtureDeploymentPolicy,
  assertSegmentPayloadResponse,
  makeSegmentTreePath,
} from "../support/deployment-contract";

describe("fixture deployment-test boundary", () => {
  const localFixture = {
    allowFixture: true,
    baseUrl: "http://127.0.0.1:4173",
    sourceMode: "fixture" as const,
  };

  it("allows an explicit localhost fixture contract", () => {
    expect(() => assertFixtureDeploymentPolicy(localFixture)).not.toThrow();
  });

  it("rejects fixture content by default and on any remote host", () => {
    expect(() => assertFixtureDeploymentPolicy({ ...localFixture, allowFixture: false })).toThrow(
      /explicit local-test opt-in/,
    );
    for (const baseUrl of ["https://www.ziyixi.science", "https://ziyixi.science"]) {
      expect(() => assertFixtureDeploymentPolicy({ ...localFixture, baseUrl })).toThrow(
        /only for a local server/,
      );
    }
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

describe("static-export segment payload contract", () => {
  it("names the route's segment tree file", () => {
    expect(makeSegmentTreePath("/")).toBe("/__next._tree.txt");
    expect(makeSegmentTreePath("/blog")).toBe("/blog/__next._tree.txt");
    expect(makeSegmentTreePath("/blog/a-post")).toBe("/blog/a-post/__next._tree.txt");
    expect(() => makeSegmentTreePath("/blog?view=all")).toThrow(/without query/);
    expect(() => makeSegmentTreePath("https://example.com/blog")).toThrow(/root-relative/);
  });

  it("requires an exact 200 text/plain response on the requested origin and route", () => {
    const valid = {
      contentType: "text/plain; charset=utf-8",
      requestUrl: "https://www.ziyixi.science/blog/__next._tree.txt",
      responseUrl: "https://www.ziyixi.science/blog/__next._tree.txt",
      status: 200,
    };
    expect(() => assertSegmentPayloadResponse(valid)).not.toThrow();
    expect(() => assertSegmentPayloadResponse({ ...valid, status: 307 })).toThrow(/must be 200/);
    expect(() => assertSegmentPayloadResponse({ ...valid, contentType: "text/html" })).toThrow(
      /text\/plain/,
    );
    expect(() =>
      assertSegmentPayloadResponse({
        ...valid,
        responseUrl: "https://attacker.example/blog/__next._tree.txt",
      }),
    ).toThrow(/changed origin or route/);
  });
});
