import type { Metadata } from "next";

import { getContentBundle, getSiteData } from "@/app/_site-data";
import { BlogList } from "@/components/BlogList";
import { PageShell } from "@/components/PageShell";
import { createWebsiteOpenGraph } from "@/lib/metadata";
import styles from "@/styles/site.module.css";

export async function generateMetadata(): Promise<Metadata> {
  const { profile, siteConfig } = await getSiteData();
  const description = `Writing by ${profile.name}.`;
  return {
    alternates: { canonical: "/blog" },
    description,
    openGraph: createWebsiteOpenGraph({
      description,
      language: siteConfig.defaultLanguage,
      path: "/blog",
      profile,
      siteConfig,
      title: "Blog",
    }),
    title: "Blog",
  };
}

export default async function BlogPage() {
  const [{ snapshot }, { siteConfig }] = await Promise.all([getContentBundle(), getSiteData()]);
  return (
    <PageShell current="blog">
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Blog</h1>
      </header>
      <BlogList posts={snapshot.posts} preferredLanguage={siteConfig.defaultLanguage} />
    </PageShell>
  );
}
