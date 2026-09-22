import type { ReactNode } from "react";

import { getSiteData } from "@/app/_site-data";
import styles from "@/styles/site.module.css";

import { SiteHeader, type NavigationSection } from "./SiteHeader";

interface PageShellProps {
  children: ReactNode;
  current?: NavigationSection;
}

export async function PageShell({ children, current }: PageShellProps) {
  const { profile } = await getSiteData();
  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main-content">
        Skip to content
      </a>
      <SiteHeader current={current} name={profile.name} />
      <main className={styles.main} id="main-content" tabIndex={-1}>
        {children}
      </main>
      <footer className={styles.footer}>
        <p>&copy; {new Date().getUTCFullYear()} Ziyi Xi</p>
        <a href="/feed.xml">RSS</a>
      </footer>
    </div>
  );
}
