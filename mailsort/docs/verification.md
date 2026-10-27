# Mailsort verification

What was actually tested, by date. Checks use synthetic mail and loopback fake Google and model endpoints;
every Google request is checked against the closed operation table of `gmail.ts`. Production acceptance read only
counts, settings and status metadata: no message body, subject, sender or message ID entered a record. Model
output counts are not mailbox accuracy. Current behaviour is in [design](design.md); the run-by-run records this
page condenses are in the repository history at `4ed50919` (`docs/mailsort-*.md`).

## Priority labels and cutover

2026-10-23/24. Four real Gmail labels replace the topic labels: P1 stays in Inbox, P2-P4 archive and valid
uncertainty becomes P1. The owner-confirmed `InitializePriorities` ran once in production and reloaded with
exactly four active rows; it removed only the frozen managed labels and learning, and kept every message, its
unread/star state and Inbox position. The owner's explicit unread batch then classified 99 unread messages with
zero failures inside the existing budgets. Synthetic tests do not establish the result for later real mail.
Evidence: [release of `d1295e7d`](https://github.com/ziyixi/todofy/actions/runs/40056081312).

## Original 100 and Workers AI calibration

2026-10-24, on the since-retired Workers AI (Clef) path. A counts-only audit found every assigned P1 came from the
uncertainty fallback; the calibrated core kept the original model choice beside the assigned P1 and excluded
unconfirmed fallbacks from learning. Its 16 public fixtures were in-sample regressions, not production accuracy.
The owner rejected a guard for concurrent manual label edits; it and its tests were removed.

The owner's original-100 recheck closed at 45 Gmail changes, 50 unchanged judgments and 5 unstarted entries the
owner cancelled; they must not resume. Older snapshots counted unchanged judgments as "skipped". The later Claude
rejudgment of the same cohort reports 52 applied and 48 unchanged.
Evidence: [release of `eb3e21dc`](https://github.com/ziyixi/todofy/actions/runs/40065406437).

## Claude provider

2026-10-24/25. The existing Worker, SQLite DO, Alarm, Gmail grant and write ledger were reused; the old `AI`
binding was removed after the release preflight refused it until the exact retirement list named it, and provider
readback confirmed it absent. One real request with five synthetic messages returned the expected priorities.
Follow-ups, each released on its own:

- The manual unread card refreshes while visible, and eligibility is checked before daily write-cap waits.
  The owner's 113-message batch completed with 12 Gmail changes, 101 skips and no failures.
- Recheck results separate unchanged judgments from true skips; the priority badges refresh in place.
- Personal rules and the base prompt are editable (12 KiB UTF-8 together). A saved override applies to the next
  call and survived later deployments. Cache breakpoints are requested only for consecutive batches; actual cache
  reads and writes are priced separately. No production cache hit is claimed.
- Three few-shot groups cover seven synthetic messages and all four priorities; the override saved in the live
  editor survived the matching release.

Evidence: [release of `c121b02d`](https://github.com/ziyixi/todofy/actions/runs/40154139320).

## Codex provider

2026-10-25. The first `gpt-6.1-sol` assumption failed at the model stage; a read-only catalog check showed the
complete list without it, so the fixed model became `gpt-6-sol` with no automatic fallback. The owner's switch in
the real settings UI preserved every other setting and both prompts. A production-client call through Access
returned all four synthetic IDs once with valid priorities; a wrong bearer received 401. After the common SDK/CLI
upgrade, real synthetic `gpt-6.1-sol` medium turns succeeded and the defaults moved to 6.1. A natural Codex batch
and its Gmail effects were not observed. Temporary operator access was removed; operator credentials are kept
outside Git. Evidence: [default-model release](https://github.com/ziyixi/todofy/actions/runs/40223093443).

## Classification interval

2026-10-26. Settings offers 5/15/30/60-minute normal batches, default 15, persisted in the existing row; Gmail
maintenance stays at five minutes. Legacy settings are adopted once; retries, deferred work and quota holds keep
their deadlines, and an active batch keeps its frozen provider and prompt. Real Chrome showed 15 minutes selected
and the next normal batch moved earlier after the existing Alarm adopted the setting. The first CI attempt's
unchanged report-Alarm timeout has no established cause; the stale same-name test report was a collector defect,
now overwritten on rerun. Evidence: [release of `42897d14`](https://github.com/ziyixi/todofy/actions/runs/40259875945).

## Recent read Inbox mail

2026-10-26, synthetic acceptance only. Automatic intake covers the last 48 hours of Inbox without P1-P4,
read mail included. Each due batch makes one bounded catch-up query that excludes existing P labels before the
100-result cap; the receipt guard anchors on the pending entry's `added_at`, so accepted work survives provider and
quota holds. Unknown receipt dates are skipped and valid decisions stay frozen. Manual unread and recheck batches
keep their original scope. The change reached production with the later Model Router releases; natural intake has
not been observed separately. Evidence: [branch runs](https://github.com/ziyixi/todofy/actions/workflows/ci.yml?query=branch%3Acodex%2Fmailsort-recent-read-mail).

## History

- 2026-10-24: a one-off comparison of six Claude configurations on 100 private messages (one request each, about
  $3.51 at list prices) chose Opus 5.5 medium. Low missed one near-term schedule change; high and max cost more
  without fixing the decisive cases; Haiku was cheaper but promoted duplicates and delayed the near-term item.
  It used the [pinned benchmark prompt](https://github.com/ziyixi/todofy/blob/511ec5063ecc1cd3602020aa2544f6cf975090f1/mailsort/prompts/priority-classification.txt)
  and does not measure later prompt revisions. Its private inputs stayed outside Git.
- 2026-10-24: the earlier Codex/VPS batch runner was withdrawn before any production release, and the Workers AI
  (Clef) path was retired with historical records kept readable.
- 2026-10-27: Mailsort calls its model through Model Router ([Router verification](../../model-router/docs/verification.md)).
