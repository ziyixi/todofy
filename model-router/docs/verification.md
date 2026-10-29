# Model Router verification

What was actually tested, by date. Acceptance uses synthetic inputs and the public `example.org` fixture. It
reclassified no mail, recomputed no report, created no task, sent no newsletter and changed no business mode or
existing business budget. Provider keys are Router secrets; spending controls are described in [design](design.md).
The run-by-run record this page
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

## OpenAI API and saved model choices

2026-10-28 (Los Angeles). `b4990110` includes the owner's existing Newsletter changes and passed the
[branch gate](https://github.com/ziyixi/todofy/actions/runs/40815827500),
[main release](https://github.com/ziyixi/todofy/actions/runs/40817114662) and matching
[Personal cloud reconcile](https://github.com/ziyixi/todofy/actions/runs/40818862546).

The live owner Playground returned the exact synthetic JSON with an object Schema through all four direct API
routes and the existing Codex subscription route. No real mail, report or newsletter was recomputed.

| Router model | Billing | Input / output tokens | Estimate, USD |
| --- | --- | --- | --- |
| `openai/gpt-6.1-sol` | API | 56 / 20 | 0.000312 |
| `openai/gpt-6-astra` | API | 57 / 21 | 0.001620 |
| `openai/gpt-6.1-terra` | API | 57 / 21 | 0.000162 |
| `openai/gpt-6-luna` | API | 57 / 21 | 0.000017 |
| `gpt-6.1-sol` | Subscription reference | 8,801 / 23 | 0.017832, not an API charge |

The four API estimates total 0.002111 USD. Sol's owner request detail separately showed the prefixed Router ID
and the native reported model `gpt-6.1-sol`. Historical subscription rows display Codex without being rewritten.
The production Mailsort and Todofy selectors both list separate Codex and OpenAI API choices. Read-only inspection
confirmed the saved choices stayed Codex; Mailsort kept medium effort. Save/reload, worker restart and the next
mail/report/recommendation using a newly selected API model were tested with synthetic workerd/SQLite fixtures,
not by changing production business settings.

OpenAI's UTC-month estimate stop reuses the request ledger. Workerd tests verify rejection before a provider call
or request/body registration at the limit, admission below it, failed-call cost inclusion, month rollover and no
effect on Codex or Claude. This is not a supplier invoice hard cap; unknown usage and in-flight requests can differ.
No new dependency, queue, table or ordinary inference field was added.

Home's fresh Cloudflare configuration check completed at 21:54 Los Angeles time with no configuration difference
in any category. The prior cached Brief findings cleared through the check; alert dismissal was not used.

## Boundaries

Local and CI suites cover provider failures, retries, cancellation, replay, unknown usage and body expiry.
Production acceptance injected no provider failure and expired no real record. A natural business run is
separate evidence; none was recomputed for these checks.
