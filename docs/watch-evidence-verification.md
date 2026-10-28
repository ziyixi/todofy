# Watch page-evidence verification

Page evidence shipped on 2026-10-23 in the
[same-SHA main release](https://github.com/ziyixi/todofy/actions/runs/39952782780), after its private bucket was created
through the gated Infra apply. What it showed, with synthetic pages, synthetic Work and a public test page only:

- Watch saves bounded page text, links, metadata and, for browser watches, one viewport JPEG in private R2 indexed by
  its SQLite DO. It calls no model and decides no relevance; ordinary rules, confirmations and Tasks are unchanged.
- Real Browser Run captured the public page. A real Dot read the Markdown with `watch_read` and the image with
  `watch_view`, then resumed from a real evidence `work.attention` report and saved a `watch_review` decision whose
  `change_ref` was the real snapshot.
- workerd tests with real SQLite and R2 cover visual-only changes, reuse of identical captures, interrupted uploads,
  owner edits during storage, retention with pinned baselines and bounded cleanup, and an undelivered Tasks digest
  surviving a full evidence feed.

Current behaviour, including the 2026-10-27 changes (no accessibility tree, noise-free comparison, evidence storage
failures no longer failing a check), is in [Watch's design](../watch/docs/design.md#page-evidence-2026-10-23).
