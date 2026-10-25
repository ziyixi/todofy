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
          Effective and last updated <time dateTime="2026-10-25">October 25, 2026</time>.
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
            labels: P1, P2, P3 and P4. P1 is for mail requiring prompt attention, including the
            owner&apos;s daily briefing, and stays in the inbox. P2 holds important information or
            required follow-up that can wait two or three days, P3 is personal periodic summaries or
            worthwhile weekend reading, and P4 is routine information or promotions without
            meaningful follow-up. P2, P3 and P4 are archived out of the inbox. Every classification
            preserves the message&apos;s read or unread state.
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
            archived message into the inbox. The selected provider&apos;s limits, modes and Gmail
            write limits apply, and the app preserves read or unread state, stars and unrelated
            labels throughout.
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
          messages to the owner&apos;s selected provider. The owner can choose Claude API or VPS
          Codex in the dashboard. Claude uses Opus 5.5 medium; Codex uses OpenAI&apos;s gpt-6.1-sol
          with medium effort through an independent service on the owner&apos;s VPS. The choice is
          saved; existing settings use Claude until the owner switches. Both choices use the same
          prompt, which asks for a reading queue and a short reason for each message. The owner can
          edit the base instructions and personal rules in the dashboard. Those preferences
          currently cover USPS delivery previews, Daily Briefing and shopping receipts. There are no
          sender-specific code branches, probability thresholds, second model vote or
          learned-example context.
        </p>
        <p>
          The selected provider receives masked sender display name/domain, subject (up to 200
          characters), body (up to 12,000 characters, with a truncation flag), message identifiers,
          receipt time, evaluation time and the America/Los_Angeles timezone. Addresses and long
          numbers are masked and links reduced to their domains before transmission. Attachments are
          not sent. Claude calls go directly to Anthropic. Codex calls pass through the owner&apos;s
          VPS to OpenAI, using the owner&apos;s existing ChatGPT subscription login. The gateway has
          no Gmail authorization and gives the model no business tools or web access. It executes
          one synchronous request without saved inference jobs, autonomous work or mail-content
          logs. Neither application path logs request or response content.
        </p>
        <p>
          While Claude is selected, consecutive batches can request Anthropic&apos;s five-minute
          prompt cache for the fixed base instructions and personal rules. Message-specific mail and
          evaluation times follow those cache breakpoints and are not marked for prompt caching.
          Ordinary hourly single batches do not request cache creation. Actual returned cache reads
          and writes are included in the app&apos;s token and cost records.
        </p>
        <p>
          Provider errors leave mail pending through the existing retry process; they do not assign
          P1 or switch providers automatically. A dedicated Claude workspace has a $20 monthly spend
          limit. Returned Claude token usage and nominal cost are recorded without message content.
          Its exhausted monthly allowance waits until the next UTC month. That cap and the explicit
          cache policy apply only to Claude. Codex uses the subscription account&apos;s availability
          and usage limits, with no API-key or model fallback. Switching preserves Claude&apos;s
          usage history, the saved prompt, mode and Gmail write limits. Reached daily Gmail write
          limits leave writes waiting regardless of provider.
        </p>
        <p>
          Each message is judged independently. Normal processing retains its new-mail cutoffs;
          processing older unread mail requires an explicit batch request. Deploying a model or
          prompt or provider change does not reclassify previously labelled mail or start a manual
          batch. Old model probabilities, examples and replay results remain historical records.
          Active embedding, automatic learning and replay model jobs are retired.
        </p>

        <h2>What is stored, and for how long</h2>
        <p>
          Classification records are stored in the owner&apos;s own Cloudflare account. The Codex
          gateway processes masked input temporarily and has no mail database. Daily cleanup applies
          these retention periods:
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
          <li>
            The owner&apos;s saved base instructions and personal rules: until replaced or the owner
            deletes the app&apos;s stored data. Saving instructions affects subsequent model calls
            without changing older classification records.
          </li>
        </ul>
        <p>
          Logs hold counts and codes only, never subjects, senders, addresses or label names.
          Google&apos;s authorization, the Claude API key and the gateway&apos;s inference/Access
          credentials are kept as secrets in the owner&apos;s own Cloudflare account, never in
          source code or GitHub release secrets. The ChatGPT subscription login stays on the
          owner&apos;s VPS; Gmail authorization is not sent there.
        </p>

        <h2>How the data is used</h2>
        <p>
          The data is used only to label the owner&apos;s own mailbox. It is not sold or used for
          advertising. Cloudflare hosts the app and its stored records. Depending on the saved
          choice, Anthropic receives the masked inputs directly, or OpenAI receives them through the
          owner&apos;s VPS. Mail is not used by this app to train a generalized model. Provider
          processing follows the terms for the selected service.
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
