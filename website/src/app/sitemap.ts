import type { MetadataRoute } from "next";

import { getContentBundle, getSiteData } from "@/app/_site-data";
import { articleLanguageAlternates } from "@/lib/metadata";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [{ snapshot }, { siteConfig }] = await Promise.all([getContentBundle(), getSiteData()]);
  const route = (path: string) => new URL(path, siteConfig.canonicalOrigin).toString();
  return [
    { changeFrequency: "monthly", priority: 1, url: route("/") },
    { changeFrequency: "weekly", priority: 0.8, url: route("/blog") },
    { changeFrequency: "yearly", priority: 0.7, url: route("/publications") },
    ...snapshot.posts.map((post) => ({
      changeFrequency: "monthly" as const,
      lastModified: post.updatedAt ?? post.publishedAt,
      priority: 0.6,
      url: route(`/blog/${post.slug}`),
      alternates: {
        languages: articleLanguageAlternates(snapshot.posts, post, siteConfig.canonicalOrigin),
      },
    })),
  ];
}
