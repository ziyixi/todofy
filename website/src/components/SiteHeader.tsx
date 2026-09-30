import Link from "next/link";

import styles from "@/styles/site.module.css";

export type NavigationSection = "home" | "blog" | "publications";

interface SiteHeaderProps {
  current?: NavigationSection;
  name: string;
}

const links: Array<{
  href: "/" | "/blog" | "/publications";
  label: string;
  id: NavigationSection;
}> = [
  { href: "/", label: "About", id: "home" },
  { href: "/blog", label: "Blog", id: "blog" },
  { href: "/publications", label: "Publications", id: "publications" },
];

export function SiteHeader({ current, name }: SiteHeaderProps) {
  return (
    <header className={styles.header}>
      <Link className={styles.siteName} href="/">
        {name}
      </Link>
      <nav aria-label="Primary" className={styles.nav}>
        {links.map((link) => (
          <Link
            aria-current={current === link.id ? "page" : undefined}
            className={styles.navLink}
            href={link.href}
            key={link.id}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
