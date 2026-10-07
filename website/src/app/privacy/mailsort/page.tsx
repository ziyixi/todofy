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
          Effective and last updated <time dateTime="2026-10-07">October 7, 2026</time>.
        </p>
      </header>
      <div className={articleStyles.articleBody}>
        <h2>What mailsort is</h2>
        <p>
          mailsort is a personal tool of the owner of this website. It labels the owner&apos;s own
          Gmail, is not offered to anyone else, and its dashboard is open to the owner only.
        </p>

        <h2>What it can do in Gmail</h2>
        <ul>
          <li>
            It asks Google for the <code>gmail.readonly</code> scope first and{" "}
            <code>gmail.modify</code> later, never for the full{" "}
            <code>https://mail.google.com/</code> scope.
          </li>
          <li>
            Through a closed list of Gmail API operations it reads messages, their labels, the
            mailbox&apos;s list of labels and its change history; creates the labels the owner sets
            up in its dashboard (and the parent labels Gmail nests them under), and renames them;
            adds one of those labels to a message and may remove the message from the inbox
            (archive). An undo removes that label and puts the message back in the inbox.
          </li>
          <li>
            It never sends, deletes or trashes mail and never marks mail read or unread. The only
            labels it renames or adds to mail are the ones it created and the ones the owner linked
            in its dashboard by giving a label there exactly the name of an existing Gmail label;
            the only other label it changes on a message is the inbox.
          </li>
          <li>
            Every change it makes to a message is recorded in its ledger first and, while the entry
            is kept (180 days), can be undone from there, unless the owner has since moved the mail
            to another label or the label was deleted.
          </li>
        </ul>

        <h2>How mail is processed</h2>
        <p>
          A new message is decided by the owner&apos;s rules, the nearest examples the owner has
          confirmed or corrected (or left alone for three days), compared through embeddings from
          the bge-m3 model, and a decision model (Clef on Cloudflare Workers AI). All of this runs
          in the owner&apos;s own Cloudflare account. The models are called directly, without AI
          Gateway, which would log request bodies.
        </p>
        <p>
          The models read masked text only: the sender&apos;s display name and domain, the subject
          (up to 200 characters), Gmail&apos;s snippet (300), the first text part of the body
          (2,000), Gmail&apos;s category, whether the message came from a mailing list, a short code
          derived from the address it was delivered to (never the address), and the masked summaries
          of similar examples, together with the owner&apos;s label names and descriptions. Email
          addresses and numbers of six or more digits are masked, and links are cut to their domain,
          before a model sees them.
        </p>

        <h2>What is stored, and for how long</h2>
        <p>Everything is stored in the owner&apos;s own Cloudflare account and cleared daily:</p>
        <ul>
          <li>
            A decision&apos;s content (masked subject, sender and summary, and the exact sender
            address, domain, List-Id and delivered-to address): 14 days.
          </li>
          <li>The review queue (masked subject and sender): 14 days after the message arrived.</li>
          <li>Decisions and the ledger of changes, without content: 180 days.</li>
          <li>
            Examples (a masked summary of at most 200 characters and its embedding): until the owner
            deletes them, at most 2,000.
          </li>
          <li>
            Rules (a sender address, domain, List-Id or delivered-to address, subject words and the
            owner&apos;s evidence and notes): until the owner deletes them, at most 500.
          </li>
          <li>
            Labels (their names, some read from Gmail, the Gmail labels they are linked to, and the
            owner&apos;s descriptions): until the owner deletes them, at most 24.
          </li>
          <li>
            Answers to the owner&apos;s own changes in the dashboard, kept so that a retried request
            is not applied twice (they can hold a masked subject and sender or a rule&apos;s
            values): 1 day.
          </li>
          <li>Daily counters without content: 400 days.</li>
        </ul>
        <p>
          Logs hold counts and codes only, never subjects, senders, addresses or label names.
          Google&apos;s authorization is kept only as encrypted secrets in the owner&apos;s own
          Cloudflare account, never in source code or on GitHub.
        </p>

        <h2>How the data is used</h2>
        <p>
          The data is used only to label the owner&apos;s own mailbox and is read by no one but the
          owner. It is not sold, not used for advertising, not used to train generalized AI models
          and not shared with anyone; Cloudflare processes it only as the host and model provider
          (Workers AI) of the owner&apos;s own account.
        </p>
        <p>
          mailsort&apos;s use and transfer to any other app of information received from Google APIs
          will adhere to the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes">
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
          . Revoking stops every Gmail read and write but does not delete what is stored: content
          expires as listed above, and examples, rules and labels stay until the owner deletes them
          in the mailsort dashboard (deleting a label also deletes its rules and examples).
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
