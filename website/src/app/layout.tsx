import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import { getSiteData } from "@/app/_site-data";
import "@/styles/globals.css";
import "katex/dist/katex.min.css";

const sourceSans = localFont({
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
  src: [
    {
      path: "../fonts/source-sans-3-latin-wght-normal.woff2",
      style: "normal",
      weight: "200 900",
    },
    {
      path: "../fonts/source-sans-3-latin-wght-italic.woff2",
      style: "italic",
      weight: "200 900",
    },
  ],
  variable: "--font-source-sans",
});

const sourceSerif = localFont({
  display: "swap",
  fallback: ["Georgia", "serif"],
  src: [
    {
      path: "../fonts/source-serif-4-latin-wght-normal.woff2",
      style: "normal",
      weight: "200 900",
    },
    {
      path: "../fonts/source-serif-4-latin-wght-italic.woff2",
      style: "italic",
      weight: "200 900",
    },
  ],
  variable: "--font-source-serif",
});

export async function generateMetadata(): Promise<Metadata> {
  const { profile, siteConfig } = await getSiteData();
  return {
    metadataBase: new URL(siteConfig.canonicalOrigin),
    title: {
      default: siteConfig.title,
      template: `%s · ${siteConfig.title}`,
    },
    description: siteConfig.description,
    authors: [{ name: profile.name, url: "/" }],
    creator: profile.name,
    openGraph: {
      description: siteConfig.description,
      images: [
        {
          alt: profile.portrait.alt,
          height: profile.portrait.height,
          url: profile.portrait.src,
          width: profile.portrait.width,
        },
      ],
      locale: siteConfig.defaultLanguage === "zh-CN" ? "zh_CN" : "en_US",
      siteName: siteConfig.title,
      title: siteConfig.title,
      type: "website",
    },
  };
}

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#FAFBFA",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { siteConfig } = await getSiteData();
  return (
    <html
      className={`${sourceSans.variable} ${sourceSerif.variable}`}
      lang={siteConfig.defaultLanguage}
    >
      <body>{children}</body>
    </html>
  );
}
