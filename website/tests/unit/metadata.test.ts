import { describe, expect, it } from "vitest";

import type { Profile, SiteConfigData } from "../../src/lib/content";
import { createArticleOpenGraph, createWebsiteOpenGraph } from "../../src/lib/metadata";

const siteConfig = {
  canonicalOrigin: "https://www.ziyixi.science",
  title: "Ziyi Xi",
  description: "Site description",
  defaultLanguage: "en",
  blogSource: "empty",
  homePostLimit: 3,
  featuredPublicationIds: [],
  notion: {
    apiVersion: "2026-03-11",
    propertyNames: {
      title: "Title",
      slug: "Slug",
      status: "Status",
      publishedAt: "PublishedAt",
      summary: "Summary",
      language: "Language",
      tags: "Tags",
    },
  },
} satisfies SiteConfigData;

const profile = {
  name: "Ziyi Xi",
  bioParagraphs: ["Biography"],
  portrait: {
    src: "/profile/ziyixi-portrait.png",
    alt: "Portrait of Ziyi Xi",
    width: 256,
    height: 256,
  },
  links: [],
} satisfies Profile;

describe("Open Graph metadata", () => {
  it("includes the public image, site name, and default locale on a child page", () => {
    expect(
      createWebsiteOpenGraph({
        description: "Writing by Ziyi Xi.",
        language: "en",
        path: "/blog",
        profile,
        siteConfig,
        title: "Blog",
      }),
    ).toEqual({
      description: "Writing by Ziyi Xi.",
      images: [
        {
          alt: "Portrait of Ziyi Xi",
          height: 256,
          url: "/profile/ziyixi-portrait.png",
          width: 256,
        },
      ],
      locale: "en_US",
      siteName: "Ziyi Xi",
      title: "Blog",
      type: "website",
      url: "/blog",
    });
  });

  it("uses the article language for locale while retaining every shared field", () => {
    expect(
      createArticleOpenGraph({
        description: "Article summary",
        language: "zh-CN",
        modifiedTime: "2026-09-21T01:00:00.000Z",
        path: "/blog/chinese-article",
        profile,
        publishedTime: "2026-09-20T01:00:00.000Z",
        siteConfig,
        title: "中文文章",
      }),
    ).toMatchObject({
      images: [
        {
          alt: "Portrait of Ziyi Xi",
          height: 256,
          url: "/profile/ziyixi-portrait.png",
          width: 256,
        },
      ],
      locale: "zh_CN",
      modifiedTime: "2026-09-21T01:00:00.000Z",
      publishedTime: "2026-09-20T01:00:00.000Z",
      siteName: "Ziyi Xi",
      type: "article",
      url: "/blog/chinese-article",
    });
  });
});
