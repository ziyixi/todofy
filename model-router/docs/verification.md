# Model Router verification

What was actually tested, by date. Acceptance uses synthetic inputs and the public `example.org` fixture. It
reclassified no mail, recomputed no report, created no task, sent no newsletter and changed no business mode or
budget. Provider keys are Router secrets; spending is capped at the provider. The run-by-run record this page
condenses is in the repository history at `4ed50919` (`docs/model-router-verification.md`).

## Initial rollout

2026-10-27. The private Playground returned the same schema-constrained synthetic JSON through Sol 6.1
(subscription), Claude Opus 5.5 and Gemini Flash-Lite. Claude and Gemini report their native model IDs; the Codex
SDK reports none, and the console shows 未提供. The shared Python client, under the existing Newsletter identity,
kept a random marker across two turns of one context and acknowledged close, without running the Newsletter
workflow. Two synthetic BGE-M3 inputs returned two finite 1,024-dimension vectors; their unreported tokens stay
unknown rather than zero. Todofy's settings select Sol 6.1 for summaries and reports, completed content stays
frozen, and a synthetic Mail Hero/Todofy canary completed through the normal controller observation.
Evidence: [release of `dfc814d7`](https://github.com/ziyixi/todofy/actions/runs/40457569495).
Since the October 27 cleanup the Newsletter identity may call Codex models only, so a rerun of the Opus, Gemini or
BGE-M3 checks uses the owner's Access identity.

## Slim API, console and backups

2026-10-27. Generation takes a flat `model + input` with only real business options, and a final Generation
has seven fields. Owner history, usage and retention live in a separate console projection. Live synthetic calls
through all three providers returned the exact marker; API estimates and subscription reference values are kept
apart, and reference values are not bills. One context check recorded an actual search; a second recorded one
literal-URL open of the public fixture. Model text alone was never taken as tool evidence.

The create-only bootstrap added only the private backup bucket and its lifecycle; no existing data was deleted.
The first cloud backup copied request metadata and every retained body, and a known synthetic body matched its
source byte for byte. Backups run daily at 04:47 UTC and are kept seven days. Local tests restore several gzip
pages and exact bodies with their expiry into a fresh SQLite and body target, through real workerd D1 and R2.
The next natural backup and a fresh-account cloud restore were not exercised ([backup](backup.md)).
Evidence: [release of `8adaf089`](https://github.com/ziyixi/todofy/actions/runs/40486158347).

## Cost visibility and array schemas

2026-10-27. One request without a price no longer hides a whole aggregate: buckets return known subtotals with
priced and unpriced counts, and a known zero stays zero. Sol reference values use the documented Standard text
rates. Missing estimates were derived from existing metadata only; failed requests without usage stay unpriced.
Array-root output schemas are wrapped privately and unwrapped and validated on return, so a synthetic root-array
request that failed before now succeeds; callers keep their provider-neutral contract. The gateway keeps typed SDK
error categories and Router preserves safe upstream reasons; older generic failures were not relabelled.
Evidence: [release of `129d5fe9`](https://github.com/ziyixi/todofy/actions/runs/40544317131).

## Boundaries

Local and CI suites cover provider failures, retries, cancellation, replay, unknown usage and body expiry.
Production acceptance injected no provider failure and expired no real record. A natural business run is
separate evidence; none was recomputed for these checks.
