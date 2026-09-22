import type { MetadataRoute } from "next";

import { getSiteData } from "@/app/_site-data";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const { siteConfig } = await getSiteData();
  return {
    host: siteConfig.canonicalOrigin,
    rules: { allow: "/", userAgent: "*" },
    sitemap: new URL("/sitemap.xml", siteConfig.canonicalOrigin).toString(),
  };
}
