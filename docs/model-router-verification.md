# Model Router verification

## Scope

Acceptance uses synthetic inputs and the public `example.org` fixture. It does not reclassify mail,
recompute reports, create Tasks, send a newsletter or change business modes and budgets.
Provider API keys were transferred through browser memory directly to Router secrets. No current
provider key was written to a local file, GitHub or the VPS. Claude uses the original Brief workspace's
verified $80/month limit; its replacement key has the owner-approved no-expiry setting.

## Verified calls on 2026-10-27 UTC

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
Synthetic Mail Hero/Todofy canary `canary-manual-20261027T061058Z` was started through Home; its controller's
next scheduled observation and old-credential retirement are pending at this checkpoint.

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
