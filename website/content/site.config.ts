export const siteConfig = {
  canonicalOrigin: "https://www.ziyixi.science",
  title: "Ziyi Xi",
  description:
    "Ziyi Xi is a software engineer on Google's Search Quality team, working on query understanding and efficient language models.",
  defaultLanguage: "en",
  blogSource: "notion",
  homePostLimit: 3,
  featuredPublicationIds: ["xi-2024-deep-earthquakes", "xi-2024-eara"] as const,
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
      translationKey: "TranslationKey",
    },
  },
} as const;

export type SiteConfig = typeof siteConfig;
