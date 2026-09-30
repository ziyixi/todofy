import type { Metadata } from "next";

import { getPostTranslations, type Post, type Profile, type SiteConfigData } from "@/lib/content";

export function articleLanguageAlternates(posts: Post[], post: Post, origin: string) {
  const translations = getPostTranslations(posts, post);
  if (translations.length < 2) return undefined;
  return Object.fromEntries(
    translations.map((translation) => [
      translation.language,
      new URL(`/blog/${translation.slug}`, origin).toString(),
    ]),
  );
}

interface SharedOpenGraphOptions {
  description: string;
  language: Post["language"];
  path: string;
  profile: Profile;
  siteConfig: SiteConfigData;
  title: string;
}

interface ArticleOpenGraphOptions extends SharedOpenGraphOptions {
  modifiedTime?: string;
  publishedTime: string;
}

const OPEN_GRAPH_LOCALES: Record<Post["language"], string> = {
  en: "en_US",
  "zh-CN": "zh_CN",
};

function sharedOpenGraph({
  description,
  language,
  path,
  profile,
  siteConfig,
  title,
}: SharedOpenGraphOptions) {
  return {
    description,
    images: [
      {
        alt: profile.portrait.alt,
        height: profile.portrait.height,
        url: profile.portrait.src,
        width: profile.portrait.width,
      },
    ],
    locale: OPEN_GRAPH_LOCALES[language],
    siteName: siteConfig.title,
    title,
    url: path,
  };
}

export function createWebsiteOpenGraph(
  options: SharedOpenGraphOptions,
): NonNullable<Metadata["openGraph"]> {
  return {
    ...sharedOpenGraph(options),
    type: "website",
  };
}

export function createArticleOpenGraph({
  modifiedTime,
  publishedTime,
  ...options
}: ArticleOpenGraphOptions): NonNullable<Metadata["openGraph"]> {
  return {
    ...sharedOpenGraph(options),
    modifiedTime,
    publishedTime,
    type: "article",
  };
}
