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
          Effective and last updated <time dateTime="2026-10-24">October 24, 2026</time>.
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
            mailbox&apos;s list of labels and its change history, and creates four flat Gmail
            labels: P1, P2, P3 and P4. P1 is for mail that needs prompt attention and stays in the
            inbox. P2 holds important information or required follow-up that can wait two or three
            days, P3 is substantive optional reading for the weekend, and P4 is routine information,
            receipts or promotions without meaningful follow-up. P2, P3 and P4 are archived out of
            the inbox. Every classification preserves the message&apos;s read or unread state.
          </li>
          <li>
            It never sends, deletes or trashes mail and never marks mail read or unread. A new
            classification adds one priority label and replaces any earlier P1–P4 labels on that
            message. Other message labels remain unchanged. An undo removes the new label, restores
            the priority labels it replaced and its original inbox position, including when the
            message was already archived before classification.
          </li>
          <li>
            An hourly job processes unread mail without a P1–P4 label, including archived mail. The
            owner can explicitly request a one-time reclassification of all current unread messages,
            including those already carrying P1–P4. Read mail, Spam, Trash, Sent and Draft are
            excluded. Labels, stars and read state are otherwise preserved.
          </li>
          <li>
            The owner can explicitly start a one-time switch from the old categories to P1–P4. This
            deletes only the old Gmail labels managed by mailsort, including its old grouping labels
            where eligible. It keeps every message, its inbox position, read or unread state and
            other labels. It also clears the old examples, trusted sender domains, review queue and
            replay results. Older decisions and write ledgers remain under the retention periods
            below, but do not feed the new priority learning or evaluation. An explicit unread batch
            may replace a selected message&apos;s latest decision with its new priority decision;
            older write ledgers remain. Writes under removed labels can no longer be undone through
            mailsort.
          </li>
          <li>
            Every change it makes to a message is recorded in its ledger first and, while the entry
            is kept (180 days), can be undone from there, unless the owner has since changed the
            mail&apos;s labels or the label was deleted.
          </li>
        </ul>

        <h2>How mail is processed</h2>
        <p>
          A job on the owner&apos;s VPS checks once an hour and uses GPT-6.1 Sol medium through the
          official Codex SDK and the owner&apos;s ChatGPT subscription. The Cloudflare Worker
          retains the Gmail authorization, prepares masked inputs and records the results before
          applying labels through its write ledger. The VPS does not receive the Gmail credential.
        </p>
        <p>
          Inputs include the sender&apos;s display name and domain, the masked subject and snippet,
          up to 12,000 characters of visible body text, message and thread identifiers, the receipt
          time, current judgment time and local time zone. HTML is cleaned before truncation, which
          is indicated to the model. Email addresses and long numbers are masked and links are
          reduced before classification. Attachments are not fetched.
        </p>
        <p>
          One maintained prompt judges the complete batch, at most 100 messages, in one SDK turn.
          The model returns P1–P4 and a short reason. It has no browser or command tools and cannot
          follow email links or modify Gmail. There is no sender-brand routing, probability gate,
          fallback classifier or automatic training from earlier labels.
        </p>
        <p>
          Already graded mail is not automatically reclassified. Saved decisions waiting for Gmail
          writes are not sent to the model again. A model failure leaves mail unclassified for a
          later hourly run; it does not automatically assign P1. Daily Gmail write limits leave
          accepted decisions waiting. Progress distinguishes a completed check, saved judgments,
          actual Gmail writes and failures.
        </p>

        <h2>What is stored, and for how long</h2>
        <p>
          Persistent application data is stored in the owner&apos;s Cloudflare account. The VPS
          passes masked inputs to Codex during a job without retaining an email archive. Daily
          cleanup applies these retention periods:
        </p>
        <ul>
          <li>
            A decision&apos;s content (masked subject, sender and summary, and the sender&apos;s
            domain, together with the short model reason): 14 days.
          </li>
          <li>
            Historical review entries (masked subject and sender): 14 days after the message
            arrived. New classification no longer creates this historical review queue.
          </li>
          <li>
            Decisions and the ledger of changes, without content (the sender only as a salted hash
            of the address, never the address): 180 days.
          </li>
          <li>
            Historical examples (a masked summary and embedding): until application data is deleted,
            at most 2,000. The hourly classifier does not create or use them.
          </li>
          <li>
            Historical replay records without message content: 7 days. The hourly classifier does
            not run the retired replay evaluation.
          </li>
          <li>
            The four priority labels (their names, descriptions and linked Gmail label IDs): until
            the owner deletes the app&apos;s stored data.
          </li>
          <li>
            Answers to the owner&apos;s own changes in the dashboard, kept so that a retried request
            is not applied twice (they can hold a masked subject and sender): 1 day.
          </li>
          <li>
            The latest unread batch&apos;s message identifiers, state, write-ledger links and scan
            progress, without mail content: until replaced by the next batch or the owner deletes
            the app&apos;s stored data.
          </li>
          <li>
            Hourly batch masked inputs and short reasons: 14 days. Batch identifiers, priorities and
            write-ledger links without content: 180 days. Cached claim/report replies: 1 day.
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
          owner through this application. Mailsort does not sell it, use it for advertising or train
          models. Cloudflare hosts the application, the owner&apos;s VPS runs the hourly job, and
          OpenAI processes the masked classification input through Codex. OpenAI processing follows
          the owner&apos;s ChatGPT account privacy and data-control settings.
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
          expires as listed above. Historical examples and the fixed label configuration stay until
          the owner deletes the app&apos;s stored data from their Cloudflare account. Deleting that
          stored data does not delete Gmail messages.
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
