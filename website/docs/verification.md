# Website verification

What was actually tested, by date. No article content or credential is recorded here. The receipt formats are in
[release](release.md); the run-by-run record this page condenses is in the repository history at `4ed50919`
(`docs/website-sync-verification.md`).

## Daily content sync

2026-10-04 to 10-06, `da35586`. Fixtures prove receipt validation, unchanged checks without deployment, failed
builds that keep the actual check time, cancellation and run-attempt separation, lost-response correlation and
explicit Draft or archived withdrawal. They do not prove real Notion permissions, a natural Cron invocation or
live recovery after a provider outage.

In production, the push release published the site. Home's manual sync and two concurrent Home requests returned
`SYNC_UNCHANGED`, queued on the shared release lock, and left the publication time and Worker version unchanged.
The October 5 and 6 daily windows each produced a completed `Website release (cron)` run with a matching
`unchanged` receipt and no upload or `website-release` Deployment; Home showed the check and the publication
separately. Receipts do not record the Cloudflare event source, so the scheduled controller's provenance is not
established; the owner stopped that observation on 2026-10-17. Outage, cancellation and rollback paths are
covered by synthetic checks only.

The Notion cleanup changed only the Blog data source: operational fields and two views went, content, dates and all
media references stayed. The two legacy writer workflows are disabled with their history kept.
Evidence: [the October 6 daily run](https://github.com/ziyixi/todofy/actions/runs/37448792826).
