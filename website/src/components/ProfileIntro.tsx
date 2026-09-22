import Image from "next/image";

import type { Profile } from "@/lib/content";
import styles from "@/styles/site.module.css";

interface ProfileIntroProps {
  profile: Profile;
}

export function ProfileIntro({ profile }: ProfileIntroProps) {
  return (
    <section aria-labelledby="about-title">
      <h1 className={styles.sectionTitle} id="about-title">
        About
      </h1>
      <div className={styles.profileGrid}>
        <div className={styles.portraitFrame}>
          <Image
            alt={profile.portrait.alt}
            className={styles.portrait}
            fill
            priority
            sizes="(max-width: 639px) 128px, 160px"
            src={profile.portrait.src}
          />
        </div>
        <div className={styles.profileCopy}>
          {profile.bioParagraphs.map((paragraph) => (
            <p className={styles.bio} key={paragraph}>
              {paragraph}
            </p>
          ))}
          <div aria-label="Profile links" className={styles.profileLinks}>
            {profile.links.map((link) => (
              <a href={link.url} key={link.label}>
                {link.label}
              </a>
            ))}
            {profile.cvPath ? (
              <a href={profile.cvPath} type="application/pdf">
                CV <span aria-label="PDF">(PDF)</span>
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
