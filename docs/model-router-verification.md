# Model Router verification

## Scope

Acceptance uses synthetic inputs and the public `example.org` fixture. It does not reclassify mail,
recompute reports, create Tasks, send a newsletter or change business modes and budgets.
Provider API keys were transferred through browser memory directly to Router secrets. No current
provider key was written to a local file, GitHub or the VPS. Claude uses the original Brief workspace's
verified $80/month limit; its replacement key has the owner-approved no-expiry setting.

## Slim API and dashboard rollout, 2026-10-27 UTC

Source `8adaf08921f14dc3ff684f241f8e9757f9533861` passed the full
[branch gate40481469379](https://github.com/ziyixi/todofy/actions/runs/40481469379) and
[main publication40486158347](https://github.com/ziyixi/todofy/actions/runs/40486158347).
The single Tasks cold-CPU miss was10.033ms against10ms, with identical Tasks/proto source to the prior green
run; the failed-job rerun passed without code or budget changes. Main reused the exact checked images/source.
Maintenance-off reran only the existing Router release job and its dependents. A transient Cloudflare10013
asset-upload failure on the follow-on Home publication passed its same-source failed-job rerun.
[Matching reconcile40489298406](https://github.com/ziyixi/todofy/actions/runs/40489298406) passed Worker/VPS
comparison, complete account registration and resolved infrastructure drift. Maintenance is false.

Ordinary generation now takes flat `model + input`, with only actual business options. Temperature,
client request UUID, metadata, parameter echo and public GetConversation are removed. Final Generation has
seven fields instead of 21. Owner history/time/retention/statistics live in a separate console projection.
Native model IDs and providers replace the Gemini email/report policy aliases; Todofy retains those policies
locally. Keys, provider workspace cap, application budgets, modes and completed business results are unchanged.

### Real synthetic model calls

The shared Python client used the existing external Newsletter identity. These requests did not invoke its
business workflow, send mail, create Tasks or read real message/task content.

| Provider / selected native model | Request | Reported input / output | Billing classification and token estimate |
| --- | --- | --- | --- |
| OpenAI / `gpt-6.1-sol` | `82667a37-d7dd-4670-accc-0e1eaeb20ede` | 8,797 /17 | subscription; US$0.017764 API-equivalent reference |
| Anthropic / `claude-opus-5-5` | `75334d30-e479-4cad-9902-3a20a37a46d3` |233 /11 | API; estimated US$0.001152 |
| Google / `gemini-3.5-flash-lite` | `f06830ac-4f02-469b-8234-2ca91ec2726b` |25 /12 | API; estimated US$0.000038 |

All three returned the exact synthetic JSON marker. The two API estimates total US$0.001190; subscription
references are separate and are not bills. The SDK still does not independently report the serving Sol model.
`a1676aa2-466c-498d-8b91-b7a35e74c232` returned two finite 1,024-component BGE-M3 vectors in order.
Its tokens remained unavailable; platform quota estimate was 0.0172, without an invented token/USD count.

Two separate context checks preserved the same random marker into their second turn and acknowledged close:

- `5c590376-5990-4d4e-b5f0-398e6cbe5e81` / `5ced20b1-357d-439f-91a5-6cbf77795e15`
  recorded an actual search and no independently verified URL open. The first prompt did not satisfy
  the independent-open check; its retained body confirmed that the returned observations were preserved.
- `37ff237d-c4c3-43b4-9943-3d8526dc3fb7` / `b6dab92f-d665-4458-9fd8-493ff7c01b91`
  explicitly requested one literal-URL open of the public example.org fixture. The executor recorded one open,
  no search, preserved the marker and acknowledged cleanup. Model text alone was not used as tool evidence.

### Backups and interface

Create-only bootstrap applied exactly the new private backup bucket and its lifecycle; 48 existing resources
were no-ops. The managed inventory is now 50 objects. No existing mail or backup was deleted.

The first cloud backup completed at 2026-10-27T10:27:51.790Z after 9.309s: 18 completed request rows,
18 retained bodies, 908,979 body bytes, one gzip metadata page. The completion marker was read independently.
The copied body of the known synthetic request `5c590376-5990-4d4e-b5f0-398e6cbe5e81` was byte-for-byte
identical to its source (582 bytes); no real request body was downloaded for acceptance.
Daily 04:47 UTC and seven-day backup retention are configured. This round did not wait for the next natural cron.
Local tests restored multiple gzip pages and exact synthetic bytes/expiry into a fresh SQLite/body target,
including actual workerd D1/R2 copying. A fresh-account cloud restore was not performed.

Real Chrome inspection confirmed hourly/daily SVG charts, native model/provider labels, separate API/subscription
values, the reduced Playground and private request rendering. Local synthetic desktop/mobile checks verified
keyboard/hover chart interaction and no mobile overflow. Home backup/status refresh is checked separately from
bucket completion. See [backup operation](../model-router/docs/backup.md).

## Initial rollout calls on 2026-10-27 UTC

Source `3c4fda1ddf6bf42905a817c5a9494bf00f24af22` passed
[complete branch CI40447964148](https://github.com/ziyixi/todofy/actions/runs/40447964148).
The real private Playground returned the same schema-constrained synthetic JSON for all three routes:

| Requested route | Request ID | Input / output tokens | Result |
| --- | --- | --- | --- |
| Sol 6.1, medium | `bfcf929b-5693-406d-b71b-74df599defdd` | 8,802 / 17 | Success, 5.2s; subscription usage |
| Claude Opus 5.5 | `826f670d-d75e-4452-8096-2ee20acc13f2` | 249 / 11 | Success, 3.4s; estimated $0.001216 |
| Gemini Flash-Lite | `9365128f-665e-4ec8-bb3a-6fe2b8fd5aeb` | 27 / 8 | Success, 939ms; cost estimate unavailable |

Claude and Gemini reported their matching native model identifiers. The Codex SDK did not report a model
identifier; the UI correctly shows “未提供”. Its route requests `gpt-6.1-sol` through the pinned official SDK.
The Sol request detail also read its retained synthetic input, instructions, schema, output and medium effort
from private storage. The request list exposes metadata separately from those bodies.

The real shared Python client then exercised the external Newsletter identity:

- `382ef327-c26b-412e-abe1-3c1382c5a882`: first turn succeeded, reported 22,762 / 87 tokens and an actual open
  observation for `example.org`.
- `43c41c71-19a8-4728-a3c1-c1dce4fd96a0`: second turn retained the first turn's random marker and produced
  the requested confirmation, with 11,525 / 30 tokens and no additional page open.
- Explicit close acknowledged `closed`. These requests did not invoke the Newsletter workflow or delivery ledger.
- `f048a409-50be-4a8e-92f0-4209fb3268ae`: two synthetic BGE-M3 inputs returned two complete, finite 1,024-dimensional
  vectors. Workers AI did not report token usage; it remains unavailable rather than being recorded as zero.

## Resource and release checkpoint

The live RouterEngine namespace is `ca44d90abc6e4191996a0eefc39df3ce`, independently confirmed in the API and
Cloudflare UI. It is recorded in `config/resources.toml`; the initial pending exception is removed.
[Infra apply40448340660](https://github.com/ziyixi/todofy/actions/runs/40448340660) recorded one public output change
with zero resource actions, then passed its clean-plan check.

[Main40449071654](https://github.com/ziyixi/todofy/actions/runs/40449071654) verified Router, Mailsort, Brief and
the paired VPS publication, then identified three retired Gemini variables in Todofy's preflight.
Their exact retirement and namespace registration passed
[complete branch CI40456441169](https://github.com/ziyixi/todofy/actions/runs/40456441169) and
[same-SHA main40457569495](https://github.com/ziyixi/todofy/actions/runs/40457569495), source
`dfc814d7e1bdc0e7f51343f83c163cf5d2a367c3`.

The live Todofy settings now select Sol6.1 for both new email summaries and reports/recommendations. A full page
reload retained both selections; the budget page reports both saved routes. Completed content remains frozen.
Synthetic Mail Hero/Todofy canary `canary-manual-20261027T061058Z` completed through the normal 06:30 UTC
controller observation. The original upstream Claude keys and migrated caller/CSRF secrets were retired;
`b875e4a3` main40462978874 and matching reconcile40463377396 passed before the slim-API work.

The earlier VPS monitoring failure preceded this rollout. The owner restarted k3s and applied the two-field
Newsletter connection patch. A read-only check confirmed four ready running Pods with current host addresses.
The real executor catalog accepts the existing Access identity. A descriptive application User-Agent avoids
Cloudflare error1010; the Router sends that same identifier.

## Acceptance boundaries

Local and CI suites cover provider failures, retries, cancellation, replay, unknown usage and private-body expiry.
Production acceptance above does not inject provider failures or expire real records. A later natural business
run is separate evidence; none was manually recomputed for these checks. The unused Kubernetes
`codex-gateway-settings` object may remain until ordinary privileged maintenance. The first independent Gateway
release retained its old environment reference while Platform was still old. The new-SHA Gateway release used the
current renderer and removed it; a namespace-reader check confirmed no reference in the ready Deployment template.
The JWT-only binary cannot authenticate with the retired Bearer. No additional sudo step or Secret-deletion API
was added for this cleanup.
