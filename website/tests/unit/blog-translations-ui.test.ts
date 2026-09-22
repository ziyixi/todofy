import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArticleLanguages } from "../../src/components/ArticleLanguages";
import { BlogList } from "../../src/components/BlogList";
import { PublicationList } from "../../src/components/PublicationList";
import { sha256, type Post } from "../../src/lib/content";
import { articleLanguageAlternates } from "../../src/lib/metadata";

function post(slug: string, language: Post["language"], translationKey?: string): Post {
  const sourceKey = sha256(slug);
  return {
    sourceKey,
    feedGuid: `urn:ziyixi:post:${sourceKey}`,
    slug,
    language,
    translationKey,
    title: language === "en" ? "A shared article" : "同一篇文章",
    summary: "Summary",
    publishedAt: "2025-02-03T00:00:00.000Z",
    tags: [],
    blocks: [],
    toc: [],
    media: [],
  };
}

describe("bilingual article presentation", () => {
  const en = post("one-en", "en", "one");
  const zh = post("one-zh", "zh-CN", "one");

  it("counts groups before the homepage limit and keeps both language entries", () => {
    const html = renderToStaticMarkup(
      createElement(BlogList, {
        compact: true,
        limit: 2,
        posts: [en, zh, post("two-en", "en")],
      }),
    );
    expect(html.match(/<li\b/g)).toHaveLength(2);
    expect(html).toContain('href="/blog/two-en"');
    expect(html).toContain("同一篇文章");
    expect(html).toContain('hrefLang="zh-CN"');
    expect(html).toContain(">English</a>");
    expect(html).toContain(">中文</a>");
  });

  it("marks the current language and links directly to its translation", () => {
    const html = renderToStaticMarkup(
      createElement(ArticleLanguages, { translations: [en, zh], currentSlug: zh.slug }),
    );
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="/blog/one-en"');
    expect(html).not.toContain('href="/blog/one-zh"');
    expect(
      renderToStaticMarkup(
        createElement(ArticleLanguages, { translations: [en], currentSlug: en.slug }),
      ),
    ).toBe("");
  });

  it("only advertises available translations in metadata", () => {
    expect(articleLanguageAlternates([en, zh], en, "https://www.ziyixi.science")).toEqual({
      en: "https://www.ziyixi.science/blog/one-en",
      "zh-CN": "https://www.ziyixi.science/blog/one-zh",
    });
    expect(articleLanguageAlternates([en], en, "https://www.ziyixi.science")).toBeUndefined();
  });

  it("uses a real resource URL for publications that have no DOI", () => {
    const html = renderToStaticMarkup(
      createElement(PublicationList, {
        publications: [
          {
            id: "software-abstract",
            title: "Software abstract",
            authors: [{ name: "Ziyi Xi", siteOwner: true }],
            homeAuthors: "Ziyi Xi",
            venue: "Conference",
            year: 2021,
            orderWithinYear: 0,
            links: [{ label: "Code", url: "https://github.com/ziyixi/pyfk" }],
          },
        ],
      }),
    );
    expect(html).toContain('href="https://github.com/ziyixi/pyfk"');
    expect(html).not.toContain("doi.org/undefined");
  });
});
