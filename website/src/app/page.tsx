import type { Metadata } from "next";
import Link from "next/link";

import { getContentBundle, getSiteData } from "@/app/_site-data";
import { BlogList } from "@/components/BlogList";
import { JsonLd } from "@/components/JsonLd";
import { PageShell } from "@/components/PageShell";
import { ProfileIntro } from "@/components/ProfileIntro";
import { PublicationList } from "@/components/PublicationList";
import { createWebsiteOpenGraph } from "@/lib/metadata";
import styles from "@/styles/site.module.css";

export async function generateMetadata(): Promise<Metadata> {
  const { profile, siteConfig } = await getSiteData();
  return {
    alternates: { canonical: "/" },
    openGraph: createWebsiteOpenGraph({
      description: siteConfig.description,
      language: siteConfig.defaultLanguage,
      path: "/",
      profile,
      siteConfig,
      title: siteConfig.title,
    }),
  };
}

export default async function HomePage() {
  const [{ snapshot }, { profile, publications, siteConfig }] = await Promise.all([
    getContentBundle(),
    getSiteData(),
  ]);
  const featuredPublications = siteConfig.featuredPublicationIds
    .map((id) => publications.find((publication) => publication.id === id))
    .filter((publication): publication is (typeof publications)[number] => Boolean(publication));
  const posts = snapshot.posts;
  const personData = {
    "@context": "https://schema.org",
    "@type": "Person",
    description: siteConfig.description,
    image: new URL(profile.portrait.src, siteConfig.canonicalOrigin).toString(),
    name: profile.name,
    sameAs: profile.links.map((link) => link.url).filter((url) => url.startsWith("https://")),
    url: siteConfig.canonicalOrigin,
  };

  return (
    <PageShell current="home">
      <JsonLd data={personData} />
      <div className={styles.homeSections}>
        <ProfileIntro profile={profile} />
        <section aria-labelledby="blog-title">
          <h2 className={styles.sectionTitle} id="blog-title">
            Blog
          </h2>
          <div className={styles.sectionContent}>
            <BlogList
              compact
              headingLevel={3}
              posts={posts}
              limit={siteConfig.homePostLimit}
              preferredLanguage={siteConfig.defaultLanguage}
            />
          </div>
          {posts.length > 0 ? (
            <Link className={styles.allLink} href="/blog">
              All writing
            </Link>
          ) : null}
        </section>
        <section aria-labelledby="publications-title">
          <h2 className={styles.sectionTitle} id="publications-title">
            Selected publications
          </h2>
          <div className={styles.sectionContent}>
            <PublicationList compact headingLevel={3} publications={featuredPublications} />
          </div>
          <Link className={styles.allLink} href="/publications">
            All publications
          </Link>
        </section>
      </div>
    </PageShell>
  );
}
