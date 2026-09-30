import type { Metadata } from "next";

import { getSiteData } from "@/app/_site-data";
import { PageShell } from "@/components/PageShell";
import { PublicationList } from "@/components/PublicationList";
import { createWebsiteOpenGraph } from "@/lib/metadata";
import styles from "@/styles/site.module.css";

export async function generateMetadata(): Promise<Metadata> {
  const { profile, siteConfig } = await getSiteData();
  const description = `Publications by ${profile.name}.`;
  return {
    alternates: { canonical: "/publications" },
    description,
    openGraph: createWebsiteOpenGraph({
      description,
      language: siteConfig.defaultLanguage,
      path: "/publications",
      profile,
      siteConfig,
      title: "Publications",
    }),
    title: "Publications",
  };
}

export default async function PublicationsPage() {
  const { publications } = await getSiteData();
  return (
    <PageShell current="publications">
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Publications</h1>
      </header>
      <PublicationList publications={publications} />
    </PageShell>
  );
}
