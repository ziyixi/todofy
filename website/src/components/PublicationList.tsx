import type { Publication } from "@/lib/content";
import styles from "@/styles/site.module.css";

interface PublicationListProps {
  compact?: boolean;
  headingLevel?: 2 | 3;
  publications: Publication[];
}

function publicationVenue(publication: Publication): string {
  const volumeIssue = publication.volume
    ? `${publication.volume}${publication.issue ? `(${publication.issue})` : ""}`
    : undefined;
  return [publication.venue, volumeIssue, publication.pages, String(publication.year)]
    .filter(Boolean)
    .join(", ");
}

export function PublicationList({
  compact = false,
  headingLevel = 2,
  publications,
}: PublicationListProps) {
  return (
    <ol className={`${styles.publicationList} ${compact ? styles.publicationListCompact : ""}`}>
      {publications.map((publication) => {
        const primaryLink =
          publication.links.find((link) => link.label === "DOI")?.url ??
          (publication.doi ? `https://doi.org/${publication.doi}` : publication.links[0]?.url);
        return (
          <li key={publication.id}>
            {headingLevel === 2 ? (
              <h2 className={styles.publicationTitle}>
                <a href={primaryLink}>{publication.title}</a>
              </h2>
            ) : (
              <h3 className={styles.publicationTitle}>
                <a href={primaryLink}>{publication.title}</a>
              </h3>
            )}
            {compact ? (
              <p className={styles.publicationMeta}>
                <strong>{publication.homeAuthors.split(",")[0]}</strong>
                {publication.homeAuthors.includes(",")
                  ? `,${publication.homeAuthors.split(",").slice(1).join(",")}`
                  : ""}
                {" · "}
                <span className={styles.venue}>{publication.venue}</span>, {publication.year}
              </p>
            ) : (
              <>
                <p className={styles.publicationMeta}>
                  {publication.authors.map((author, index) => (
                    <span key={author.name}>
                      {index > 0 ? ", " : ""}
                      {author.siteOwner ? <strong>{author.name}</strong> : author.name}
                    </span>
                  ))}
                  {" · "}
                  <span className={styles.venue}>{publicationVenue(publication)}</span>
                </p>
                {publication.links.length > 0 ? (
                  <ul
                    aria-label={`Resources for ${publication.title}`}
                    className={styles.resourceLinks}
                  >
                    {publication.links.map((link) => (
                      <li key={`${publication.id}-${link.label}`}>
                        <a href={link.url}>{link.label}</a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}
