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
            labels: P1, P2, P3 and P4. P1 is for mail with a concrete near-term reason for prompt
            attention and stays in the inbox. P2 holds important information or required follow-up
            that can wait two or three days, P3 is personal periodic summaries or worthwhile weekend
            reading, and P4 is routine information, receipts or promotions without meaningful
            follow-up. P2, P3 and P4 are archived out of the inbox. Every classification preserves
            the message&apos;s read or unread state.
          </li>
          <li>
            It never sends, deletes or trashes mail and never marks mail read or unread. A new
            classification adds one priority label and replaces any earlier P1–P4 labels on that
            message. Other message labels remain unchanged. An undo removes the new label, restores
            the priority labels it replaced and its original inbox position, including when the
            message was already archived before classification.
          </li>
          <li>
            The owner can explicitly request classification of all current unread mail, including
            older and archived messages. The app collects their identifiers before processing that
            batch. Spam, Trash and other messages outside its normal incoming-mail rules are
            excluded; messages already carrying P1–P4 or no longer unread are skipped. P1 brings an
            archived message into the inbox. The same models, modes and quotas apply, and the app
            preserves read or unread state, stars and unrelated labels throughout.
          </li>
          <li>
            The owner can also explicitly recheck current unread mail assigned P1 because the model
            was uncertain. This excludes messages the owner has confirmed or corrected and rechecks
            their current Gmail state, skipping mail now read or no longer carrying only P1. If the
            result stays P1, only the stored model evidence changes; another Gmail write is
            unnecessary. A result of P2, P3 or P4 replaces P1 and archives through the same ledger.
          </li>
          <li>
            The owner can explicitly recheck the first 100 messages automatically graded under the
            current P1-P4 setup, including read and archived mail. The original classification
            ledger fixes this group; later arrivals do not replace its members. Messages the owner
            has confirmed or relabeled are skipped. The app preserves read state, stars and
            unrelated labels. An unchanged priority only refreshes the model evidence. Existing
            quotas and write limits still apply.
          </li>
          <li>
            The owner can explicitly start a one-time switch from the old categories to P1–P4. This
            deletes only the old Gmail labels managed by mailsort, including its old grouping labels
            where eligible. It keeps every message, its inbox position, read or unread state and
            other labels. It also clears the old examples, trusted sender domains, review queue and
            replay results. Older decisions and write ledgers remain under the retention periods
            below, and are not used by the current prompt-based classifier. An explicit unread batch
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
          The app checks Gmail through its existing Cloudflare Durable Object Alarm and starts
          classification batches roughly hourly. Each batch sends up to ten unread, unclassified
          messages to Anthropic&apos;s Claude API, using Opus 5.5 medium. A maintained prompt asks
          for a reading queue and a short reason for each message. There are no sender-brand rules,
          probability thresholds, second model vote or learned-example context.
        </p>
        <p>
          Anthropic receives masked sender display name/domain, subject (up to 200 characters), body
          (up to 12,000 characters, with a truncation flag), message identifiers, receipt time,
          evaluation time and the America/Los_Angeles timezone. Addresses and long numbers are
          masked and links reduced to their domains before transmission. Attachments are not sent.
          Calls go directly to Anthropic, without an AI Gateway that logs request bodies.
        </p>
        <p>
          Provider errors leave mail pending through the existing retry process; they do not assign
          P1. A dedicated Claude workspace has a $20 monthly spend limit. Returned token usage and
          nominal cost are recorded without message content. An exhausted monthly model allowance
          waits until the next UTC month; reached daily Gmail write limits leave writes waiting. The
          existing modes and write limits remain effective throughout.
        </p>
        <p>
          Each message is judged independently. Normal processing retains its new-mail cutoffs;
          processing older unread mail requires an explicit batch request. Deploying a model or
          prompt change does not reclassify previously labelled mail. Old model probabilities,
          examples and replay results remain historical records. Active embedding, automatic
          learning and replay model jobs are retired.
        </p>

        <h2>What is stored, and for how long</h2>
        <p>
          Data is stored in the owner&apos;s own Cloudflare account. Daily cleanup applies these
          retention periods:
        </p>
        <ul>
          <li>
            A decision&apos;s content (masked subject, sender and summary, and the sender&apos;s
            domain): 14 days.
          </li>
          <li>
            Historical review entries (masked subject and sender): 14 days after the message
            arrived. The one-time priority switch clears that queue; the current model does not
            create review entries.
          </li>
          <li>
            Decisions and the ledger of changes, without content (the sender only as a salted hash
            of the address, never the address): 180 days.
          </li>
          <li>
            Historical examples (a masked summary of at most 200 characters and its embedding):
            until the owner deletes them, at most 2,000.
          </li>
          <li>
            A historical replay evaluation (per message its identifier, the owner&apos;s answer, the
            label decided again, the model&apos;s probabilities behind it and whether the sender
            passed Gmail&apos;s DMARC check, no content): 7 days.
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
          <li>Daily counters and returned Claude token/cost totals without content: 400 days.</li>
        </ul>
        <p>
          Logs hold counts and codes only, never subjects, senders, addresses or label names.
          Google&apos;s authorization and the Claude API key are kept as secrets in the owner&apos;s
          own Cloudflare account, never in source code or on GitHub.
        </p>

        <h2>How the data is used</h2>
        <p>
          The data is used only to label the owner&apos;s own mailbox. It is not sold or used for
          advertising. Cloudflare hosts the app and its stored records; Anthropic receives the
          masked inputs above to provide the requested classification. Mail is not used by this app
          to train a generalized model. Provider processing follows the applicable API terms.
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
          expires as listed above. Individual examples can be deleted in the mailsort dashboard.
          Examples and the fixed label configuration otherwise stay until the owner deletes the
          app&apos;s stored data from their Cloudflare account. Deleting that stored data does not
          delete Gmail messages.
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
