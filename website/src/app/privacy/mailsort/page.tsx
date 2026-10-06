import type { Metadata } from "next";
import Link from "next/link";

import { getSiteData } from "@/app/_site-data";
import { PageShell } from "@/components/PageShell";
import { createWebsiteOpenGraph } from "@/lib/metadata";
import articleStyles from "@/styles/article.module.css";
import styles from "@/styles/site.module.css";

// The privacy policy named on mailsort's Google OAuth consent screen. Every statement must stay true
// for mailsort/: the Gmail operations and the retention table of mailsort/docs/design.md §2 (which
// follows `prune` in mailsort/worker/src/store.ts). Change this page in the same commit as either.

const TITLE = "mailsort privacy policy";
const DESCRIPTION =
  "How mailsort, the site owner's personal Gmail labeler, accesses, uses and keeps Google user data.";

export async function generateMetadata(): Promise<Metadata> {
  const { profile, siteConfig } = await getSiteData();
  return {
    alternates: { canonical: "/privacy/mailsort" },
    description: DESCRIPTION,
    openGraph: createWebsiteOpenGraph({
      description: DESCRIPTION,
      language: siteConfig.defaultLanguage,
      path: "/privacy/mailsort",
      profile,
      siteConfig,
      title: TITLE,
    }),
    title: TITLE,
  };
}

export default function MailsortPrivacyPage() {
  return (
    <PageShell>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{TITLE}</h1>
        <p className={styles.pageIntro}>
          Effective and last updated <time dateTime="2026-10-06">October 6, 2026</time>.
        </p>
      </header>
      <div className={articleStyles.articleBody}>
        <h2>What mailsort is</h2>
        <p>
          mailsort is a personal tool of the owner of this website. It labels the owner&apos;s own
          Gmail and is not offered to anyone else. Its dashboard, sort.ziyixi.science, is behind
          Cloudflare Access and open to the owner only.
        </p>

        <h2>What it can do in Gmail</h2>
        <ul>
          <li>
            It asks Google for the <code>gmail.readonly</code> scope first and{" "}
            <code>gmail.modify</code> later, never for the full{" "}
            <code>https://mail.google.com/</code> scope.
          </li>
          <li>
            Through a closed list of Gmail API operations it reads messages, their labels and the
            mailbox&apos;s change history, creates and renames its own labels under the prefix{" "}
            <span lang="zh-CN">分拣/</span> (&ldquo;sorting&rdquo;), adds one of its labels to a
            message and may remove the message from the inbox (archive).
          </li>
          <li>
            It never sends, deletes or trashes mail, never marks mail read or unread, and never
            changes a label it did not create. Every change it makes to a message is recorded in its
            ledger and can be undone from there.
          </li>
        </ul>

        <h2>How mail is processed</h2>
        <p>
          A new message is decided by the owner&apos;s rules, the nearest examples the owner has
          corrected (compared through embeddings from the bge-m3 model) and a decision model (Clef
          on Cloudflare Workers AI). All of this runs in the owner&apos;s own Cloudflare account: a
          Worker, a Durable Object and Workers AI. The models are called directly, without AI
          Gateway, which would log request bodies.
        </p>
        <p>
          The models read masked text only: the sender&apos;s display name and domain, the subject
          (up to 200 characters), Gmail&apos;s snippet (300), the first text part of the body
          (2,000), Gmail&apos;s category and the masked summaries of similar examples. Email
          addresses, long numbers and URLs are masked before a model sees them.
        </p>

        <h2>What is stored, and for how long</h2>
        <p>Everything is stored in the owner&apos;s own Cloudflare account:</p>
        <ul>
          <li>
            A decision&apos;s content (masked subject, sender and summary, and the exact sender
            address, domain, List-Id and delivered-to address): 14 days.
          </li>
          <li>The review queue (masked subject and sender): 14 days.</li>
          <li>Decisions and the ledger of changes, without content: 180 days.</li>
          <li>
            Examples (a masked summary of at most 200 characters and its embedding): until the owner
            deletes them, at most 2,000.
          </li>
          <li>
            Rules (a sender address, domain, List-Id or delivered-to address, subject words and the
            owner&apos;s evidence and notes): until the owner deletes them, at most 500.
          </li>
          <li>Daily counters without content: 400 days.</li>
        </ul>
        <p>
          Logs hold counts and codes only, never subjects, senders, addresses or label names. The
          Google authorization (client ID, client secret and refresh token) is stored only as
          Cloudflare Worker secrets, put there from the owner&apos;s own machine, and never in
          GitHub.
        </p>

        <h2>How the data is used</h2>
        <p>
          The data is used only to label the owner&apos;s own mailbox. It is not sold, not shared
          with third parties, not used for advertising and not used to train generalized AI models.
        </p>
        <p>
          mailsort&apos;s use and transfer of information received from Google APIs adheres to the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>

        <h2>Revoking access and deleting data</h2>
        <p>
          Access can be revoked at any time at{" "}
          <a href="https://myaccount.google.com/permissions">
            https://myaccount.google.com/permissions
          </a>
          . Stored examples and rules can be deleted one by one in the mailsort dashboard;
          everything else expires as listed above.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about this policy can go to the owner through the links on the{" "}
          <Link href="/">home page</Link>.
        </p>
      </div>
    </PageShell>
  );
}
