import { getContentBundle, getSiteData } from "@/app/_site-data";

export const dynamic = "force-static";
export const revalidate = false;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export async function GET() {
  const [{ snapshot }, { siteConfig }] = await Promise.all([getContentBundle(), getSiteData()]);
  const feedUrl = new URL("/feed.xml", siteConfig.canonicalOrigin).toString();
  const items = snapshot.posts
    .map((post) => {
      const link = new URL(`/blog/${post.slug}`, siteConfig.canonicalOrigin).toString();
      return [
        "    <item>",
        `      <title>${escapeXml(post.title)}</title>`,
        `      <description>${escapeXml(post.summary)}</description>`,
        `      <link>${escapeXml(link)}</link>`,
        `      <guid isPermaLink="false">${escapeXml(post.feedGuid)}</guid>`,
        `      <pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(siteConfig.title)}</title>`,
    `    <link>${escapeXml(siteConfig.canonicalOrigin)}</link>`,
    `    <description>${escapeXml(siteConfig.description)}</description>`,
    `    <language>${escapeXml(siteConfig.defaultLanguage)}</language>`,
    `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />`,
    items,
    "  </channel>",
    "</rss>",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return new Response(`${body}\n`, {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Type": "application/rss+xml; charset=utf-8",
    },
  });
}
