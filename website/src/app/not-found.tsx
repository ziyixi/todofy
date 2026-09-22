import type { Metadata } from "next";
import Link from "next/link";

import { PageShell } from "@/components/PageShell";
import styles from "@/styles/site.module.css";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function NotFound() {
  return (
    <PageShell>
      <div className={styles.notFound}>
        <h1 className={styles.pageTitle}>Page not found</h1>
        <p>The page may have moved, or it may no longer be published.</p>
        <Link href="/">Return home</Link>
      </div>
    </PageShell>
  );
}
