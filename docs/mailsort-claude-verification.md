# Mailsort Claude rollout

2026-10-24. The owner selected Opus 5.5 medium after the [six-condition comparison](mailsort-claude-comparison.md)
and authorized implementation with a dedicated $20/month Claude workspace.

## Implemented

The existing Cloudflare Worker, SQLite object `mailsort-v1`, Alarm, Gmail grant and write ledger are retained.
Roughly hourly classification uses one structured Claude request for up to ten unread, unclassified messages.
P1 stays in Inbox; P2-P4 archive. Existing labels, read state, stars, message IDs and history remain.
No VPS or Codex runner was added. Existing classified mail is not automatically rechecked.

The maintained prompt now clarifies the value of personal periodic reports without sender-brand rules.
The earlier comparison used [its pinned benchmark version](https://github.com/ziyixi/todofy/blob/511ec5063ecc1cd3602020aa2544f6cf975090f1/mailsort/prompts/priority-classification.txt);
its results do not measure this prompt revision.
Active Clef voting, embeddings, weak learning and replay calls are retired; historical records stay readable.
The UI reports the actual returned Claude tokens and nominal monthly cost. Home reports configuration/spend failures
and pending mail without applying account Workers AI shedding to this external model.

## Provider configuration

A dedicated `mailsort` Claude workspace was created and its monthly spend limit saved at $20. The console
showed `$0.00 / $20.00` and reset on November 1 UTC. The existing organization $80 limit and Brief workspace/key
were not changed. Included API credits count toward spend caps; see [Anthropic credits documentation](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers).
The provider configuration screenshot is private, outside Git.

The owner confirmed creation of a long-lived, Mailsort-only key without Admin API access. It was written directly
to the Mailsort Worker secret; all three existing Gmail secret names remain. The key did not enter GitHub, Git,
bootstrap maps or logs, and its temporary local plaintext file was removed after configuration and testing.
The Brief key remains unchanged.

## Local evidence

- Worker: typecheck/lint, 199 unit tests, 89 real workerd/SQLite tests and current batched-path CPU bounds passed;
  the subsequent no-pending monthly-rollover regression passed in the focused 15-case pipeline suite.
- Wrangler smoke: 25 checks, 44 Gmail requests checked against the independent closed operation table.
- UI: 76 tests, lint/types/build and asset-budget checks passed; 58.2 KiB gzip JavaScript.
- Home: label, registry and targeted workerd guard tests passed. Mailsort status stays observable and sheds are refused.
- Proto: lint, API lint, breaking and generated-schema checks passed. Frozen Ops fixtures remain unchanged.
- Deployment/config: 26 tests; cloud configuration 17, service catalog 35, bootstrap 26, Wrangler inventory 41 and CI routing 176 passed.
- Website: changed privacy page/test format/lint, generated-fixture typecheck and 31 content-preparation/redirect unit tests passed.
- Dry bundle: two modules including the prompt, 136.6 KiB gzip by the bundle checker; original 148 KiB budget retained.

Tests use synthetic mail and local fake Google/Anthropic endpoints. No real Gmail labels were changed by these checks.
The real API, release and runtime evidence follows. Local tests alone are not production acceptance.

## Real API and first release attempt

The built production client sent one batch of five synthetic messages to the real API using Opus 5.5 medium.
The API reported `claude-opus-5-5`, 2,580 input tokens, 326 output tokens and zero thinking tokens.
The nominal cost was $0.01684; all five P1-P4 choices matched the synthetic expectations. These are integration
fixtures, not a mailbox-accuracy measurement. This out-of-app test is billed to the Mailsort workspace and is
not included in the app's own usage table.

Implementation SHA `a28e24abeebe85479793b026cbee5deba89528f7` passed the complete
[branch gate](https://github.com/ziyixi/todofy/actions/runs/40132337773).
The [first same-SHA main attempt](https://github.com/ziyixi/todofy/actions/runs/40140567311) stopped before upload:
the release preflight correctly refused the old undeclared `AI` binding. Build SHA drift was an ordinary release
difference, not the blocker.

The normal release helper's exact retirement list was updated for the intentional Mailsort `AI` removal in
`ff4b3532b1f15eef3b61520b0a4fb2f29dd8fdb1`. Its complete
[branch gate](https://github.com/ziyixi/todofy/actions/runs/40140845410) passed. The
[same-SHA main release](https://github.com/ziyixi/todofy/actions/runs/40141649309) completed successfully. No broad
bypass or manual Worker code deployment was used.

The website privacy deployment from `a28e24ab` completed in
[run 40140636399](https://github.com/ziyixi/todofy/actions/runs/40140636399). A browser check confirmed the October 24
Mailsort disclosure names Anthropic and the $20 monthly workspace limit. This verifies the privacy page update.

## Production proof

The final application SHA is `ff4b3532b1f15eef3b61520b0a4fb2f29dd8fdb1`.

| App | Verified GitHub Deployment | Cloudflare version |
| --- | --- | --- |
| Mailsort | `7305900543` | `081e7f5a-2ca1-437c-9bab-5c1f00ce8ea5` |
| Home | `7305911514` | `56885555-268c-4dcf-9ac5-af92d5db64a8` |

Provider readback confirmed the final SHA, removal of the old `AI` binding, presence of `ANTHROPIC_API_KEY` and
all three Gmail secret names, and the unchanged `mailsort-state` namespace `7dd130a08de1451cab2931db6a7d178d`.
The existing stored owner mode was live, but an old daily-write-limit breaker lowered it to shadow. The browser
automation could not handle its system confirmation reliably; the owner cleared that breaker and the fresh UI
confirmed live mode and writable Gmail. No limit or Gmail grant was changed.

The deployed overview shows Claude Opus 5.5, medium effort, the $20 monthly app limit and no current model error.
At acceptance it had no recorded Claude response, zero app-recorded tokens/cost, and zero pending mail. The next
model batch was shown at October 24 17:26 America/Los_Angeles. The separate $0.01684 synthetic client request is
not part of this app tally. No natural hourly Claude call or real Gmail write is claimed as acceptance evidence.

Home's final build matches the same SHA. Its pre-clear snapshot was checked at 23:30:52 UTC and correctly showed
`breaker_tripped`. After the existing refresh cooldown, the normal Home refresh polled status at
`2026-10-24T23:41:23.022Z`: Mailsort was `ok`, with zero pending, zero consecutive failures and no top signals.
The old attention item disappeared without dismissing it. The refresh rebuilt cached observations without running
a Canary or creating a task. Screenshots remain private, outside Git.

The earlier original-100 batch ended with 45 Gmail changes, 55 skipped and zero pending after its five unstarted
rechecks were cancelled. They must not resume. This rollout starts no original-100 or all-unread reclassification.


## Manual unread progress follow-up

The owner started the default unread action at `2026-10-24T23:53:59.042Z`. It registered 113 messages. The initial
page showed 113 pending and 110 deferred with no applied/skipped entries. After the UTC day boundary, the existing
batch progressed without restart and completed: 12 actual Gmail applications, 101 skipped, zero pending/failures.
App-recorded Claude nominal monthly cost was $0.13058, with no current model error. Only status/settings metadata
was read; no message body, subject, sender or message ID was exported.

Two regressions were reproduced locally: the card retained its initial POST snapshot until manual refresh, and
a full daily write cap prevented even already-labelled messages from reaching their skip check. The fix updates
active visible progress every 30 seconds, consumes the fresh status immediately after Start, checks eligibility before
write-cap waits, and returns an exact daily write-resume timestamp. Existing limits and the real batch are preserved.


The follow-up fix `c18f73f1985bd46eef96594914b3a3154d64f2eb` passed
[branch CI 40146082647](https://github.com/ziyixi/todofy/actions/runs/40146082647) and the exact same SHA passed
[main release 40146726819](https://github.com/ziyixi/todofy/actions/runs/40146726819). Only Mailsort deployed;
all other app/VPS deployment jobs were skipped. Deployment `7306499723` verifies Worker
`f5b272b5-3919-454e-a4c7-57f651b646c1` and the unchanged DO namespace. The owner UI and metadata API showed the
new build with the same completed 113-message batch/start time, 12 actual applications, 101 skips and zero failures.
Mode remained live, the model remained Opus 5.5 medium, the monthly limit remained $20 and no model error was present.
No duplicate or new batch was started to test the UI; synthetic UI tests cover the active visible refresh loop.

Local verification included 199 Worker unit tests, 92 real workerd cases (including CPU), 23 focused unread UI
cases, the existing full synthetic Wrangler smoke, type/lint/build and proto checks. The full UI suite's original
five new regressions failed before the fix; the final branch gate also covered the additional past-timestamp case.
Private screenshot evidence shows the deployed completed card and clarified skip/immediate-queue descriptions.


## Recheck result counters and priority badge freshness

The owner then ran the original-100 recheck at `2026-10-25T00:31:22.597Z`. It completed with 52 confirmed Gmail
applications and 48 legacy skipped results. A fresh seven-day report showed P1=3, P2=3, P3=10, P4=99; the P2 category
was present on the server, while the page's badge map remained its old snapshot.

Source and synthetic regressions confirmed that a successful same-priority Claude rejudgment updated evidence and
usage without a Gmail write but was counted as skipped. The output now separates `unchanged_count` from true
`skipped_count`, deriving the distinction from existing metadata only in explicit recheck modes. There is no
storage migration, model rerun or change to the selected cohort, owner guards or budgets.

The labels page refreshes the existing report after its existing status refresh, updating badge nodes in place.
Tests cover a P2 badge changing 0 to 3, preserved expanded details/focus and a report failure remaining separate from
batch-status success. The action is named “重判最初100封” to make its earliest original cohort explicit.
Local checks passed 199 Worker unit tests, 93 real workerd cases, 86 UI tests, types/lint/build, the synthetic Wrangler
smoke and proto checks. A regression proves 100 messages all sent to Claude can yield unchanged 100 / skipped 0 with no
Gmail writes; actual owner/Spam/Trash exclusions still skip and do not reach the model. Release proof follows.


The statistics/UI fix `ed236228229450ac1c8b06de70a9f090d82c6da2` passed
[branch CI 40148723336](https://github.com/ziyixi/todofy/actions/runs/40148723336) and
[main release 40149463353](https://github.com/ziyixi/todofy/actions/runs/40149463353). Only Mailsort deployed.
Deployment `7306876510` verifies Worker `7626477f-8e3c-46b9-8d9d-0154c0913763` and the same namespace.

Fresh status retained the same batch start and returned 100 total, 52 applied, 48 unchanged, zero skipped/pending/
failures. App-recorded nominal monthly cost stayed $1.090184 across this metadata-only correction. The deployed
page showed “已改标 52 · 重判未变 48 · 未重判跳过 0”. Thus all 100 messages had actually been rejudged; the old 48
skips were successful unchanged results, not missing analysis. No additional model call or Gmail change was
triggered for verification, and no stored row/schema was rewritten.

A read-only Gmail label-count query independently showed P2 total 3 / unread 3; its ID matched Mailsort's configured
P2 label. All four configured priority labels were enabled and linked. The fresh server report and deployed P2
badge both showed 3. This resolves the stale zero display; it is not a claim that every P2 decision was a human-
reviewed gold label. The seven-day model report and Gmail's actual label totals are separate statistics.
Screenshots are private, outside Git. Completed local checks included 199 Worker unit tests, 93 workerd cases,
86 UI tests, types/lint/build, synthetic Wrangler smoke and proto checks.

## Editable prompt and cache accounting

The owner requested a personal-rules section and dashboard editing. The bundled defaults now specify USPS
Informed Delivery P2 for ordinary previews and P1 for same-day action, Daily Briefing P1, and actual shopping
receipts/order confirmations P2, including Weee and Yami. Brand promotions retain the general policy. These are
prompt instructions, with no sender-specific code paths.

The existing DO stores one optional base/rules override. Reading defaults does not write it; saving through the
generated owner API freezes both texts for the next model call and survives deployment. Settings shows personal
rules directly and the base in a collapsed section. The combined UTF-8 limit is 12 KiB. Existing batches, modes,
Gmail limits and the native $20 workspace cap are unchanged; this change requests no historical reclassification.

Stable system texts precede variable email/time input. Only consecutive batches request explicit five-minute
cache breakpoints. Ordinary hourly single batches stay uncached. Eligibility is a bounded backlog hint, so an
unneeded cache write can occur if remaining mail later skips; no per-batch saving is promised. Actual provider
cache reads/writes are persisted in existing daily usage, included in total input and priced separately. The
settings editor needs no new key, database, scheduler or prompt-version system.

Local verification passed 215 Worker unit tests, 98 real workerd/SQLite cases (including CPU), 94 UI tests,
26 config/deployment tests, the existing synthetic Wrangler smoke, Worker/UI types/lint/build and ten Home label
tests. Website checks passed the changed privacy page/test lint/format, route types/TypeScript and 298 unit tests.
Proto lint, API lint, breaking and schema checks passed. The dry Worker bundle is 139.4 KiB gzip against the
unchanged 148 KiB budget; UI JavaScript is 60.3 KiB gzip. Tests cover persisted exact
text, etag/request replay, an empty rules field, next-call prompt use, hourly uncached and backlog/tail cached
requests, actual cache pricing, billed invalid responses and legacy usage migration without double counting.

Implementation `70a60d4959289ade5691f5b9a12bf0818d756009` passed the full
[branch CI 40152547981](https://github.com/ziyixi/todofy/actions/runs/40152547981) and
[same-SHA main release 40153166848](https://github.com/ziyixi/todofy/actions/runs/40153166848).
Only Mailsort and Home Worker releases were selected, alongside the website dispatch. The separate
[privacy-page release 40153219914](https://github.com/ziyixi/todofy/actions/runs/40153219914) succeeded;
the public page actually displays editable instructions, fixed-prefix caching and prompt retention.

| App | Verified GitHub Deployment | Cloudflare version |
| --- | --- | --- |
| Mailsort | `7307375160` | `b22c80f4-4bde-445f-b767-b7e5e47dcc77` |
| Home | `7307385472` | `f68f77b1-8b78-4c1d-be7b-3651fcb2fb7a` |

Direct provider readback matched both builds to the implementation SHA, preserved the existing Mailsort namespace,
Claude/Gmail secret presence and absent legacy AI binding. No credentials were read back or changed.

At 2026-10-25 02:09 UTC the live settings page saved the requested rules with its ordinary Save button. It showed
success without a system confirmation. After reload, all three rules remained, the saved timestamp remained,
the base section was collapsed and Save was disabled until another edit. The combined text size stayed 5,002 UTF-8
bytes. The private proof image contains only the saved-status/button area, not the prompt.

The live overview stayed in the existing configuration: Opus 5.5 medium, $20 cap, 209,921 input tokens, 12,525 output
tokens (including 3,982 thinking) and $1.090184 nominal usage. It displays actual cache reads 0 / writes 0; no real
cache hit is claimed. No model request, mail reclassification or new key was added for verification. Synthetic
cache responses prove accounting and request shape, not a production hit or mailbox accuracy.
