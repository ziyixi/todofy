import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getContentBundle, getSiteData } from "@/app/_site-data";
import { ArticleBody } from "@/components/ArticleBody";
import { ArticleLanguages } from "@/components/ArticleLanguages";
import { ArticleToc } from "@/components/ArticleToc";
import { formatPostDate } from "@/components/BlogList";
import { JsonLd } from "@/components/JsonLd";
import { PageShell } from "@/components/PageShell";
import { findPostBySlug, getPostTranslations } from "@/lib/content";
import { articleLanguageAlternates, createArticleOpenGraph } from "@/lib/metadata";
import styles from "@/styles/site.module.css";

interface ArticlePageProps {
  params: Promise<{ slug: string }>;
}

export const dynamicParams = false;

export async function generateStaticParams() {
  const { snapshot } = await getContentBundle();
  return snapshot.posts.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: ArticlePageProps): Promise<Metadata> {
  const [{ slug }, { snapshot }, { profile, siteConfig }] = await Promise.all([
    params,
    getContentBundle(),
    getSiteData(),
  ]);
  const post = findPostBySlug(snapshot, slug);
  if (!post) notFound();
  const path = `/blog/${post.slug}`;
  return {
    alternates: {
      canonical: path,
      languages: articleLanguageAlternates(snapshot.posts, post, siteConfig.canonicalOrigin),
    },
    description: post.summary,
    openGraph: createArticleOpenGraph({
      description: post.summary,
      language: post.language,
      modifiedTime: post.updatedAt,
      path,
      profile,
      publishedTime: post.publishedAt,
      siteConfig,
      title: post.title,
    }),
    title: post.title,
  };
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const [{ slug }, { snapshot }, { profile, siteConfig }] = await Promise.all([
    params,
    getContentBundle(),
    getSiteData(),
  ]);
  const post = findPostBySlug(snapshot, slug);
  if (!post) notFound();
  const canonicalUrl = new URL(`/blog/${post.slug}`, siteConfig.canonicalOrigin).toString();
  const translations = getPostTranslations(snapshot.posts, post);
  const blogPostingData = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    author: {
      "@type": "Person",
      name: profile.name,
      url: siteConfig.canonicalOrigin,
    },
    dateModified: post.updatedAt,
    datePublished: post.publishedAt,
    description: post.summary,
    headline: post.title,
    inLanguage: post.language,
    mainEntityOfPage: canonicalUrl,
    url: canonicalUrl,
  };

  return (
    <PageShell current="blog">
      <JsonLd data={blogPostingData} />
      <article lang={post.language}>
        <header className={styles.articleHeader}>
          <h1 className={styles.articleTitle}>{post.title}</h1>
          <p className={styles.articleMeta}>
            <span>{profile.name}</span>
            <time dateTime={post.publishedAt}>{formatPostDate(post.publishedAt)}</time>
            {translations.length < 2 ? (
              <span>{post.language === "zh-CN" ? "中文" : "English"}</span>
            ) : null}
            {post.updatedAt ? (
              <span>
                Updated <time dateTime={post.updatedAt}>{formatPostDate(post.updatedAt)}</time>
              </span>
            ) : null}
          </p>
          <ArticleLanguages translations={translations} currentSlug={post.slug} />
        </header>
        {post.blocks.some((block) => block.type === "tableOfContents") ? null : (
          <ArticleToc language={post.language} toc={post.toc} />
        )}
        <ArticleBody blocks={post.blocks} language={post.language} toc={post.toc} />
      </article>
    </PageShell>
  );
}
