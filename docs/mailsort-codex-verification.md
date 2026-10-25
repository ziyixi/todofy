# Mailsort Codex verification

This record is an incomplete acceptance checkpoint. Mailsort still selects Claude.
No successful real Codex inference, production switch to Codex or old-mail reclassification is recorded.
The owner authorized the provider selector and an independent VPS inference endpoint.

## Scope and retained behavior

Mailsort keeps its existing Worker, SQLite Durable Object, Alarm, Gmail grant and write ledger.
The selector changes the engine for the next batch; it does not reclassify existing labelled mail.
Both providers use the saved base prompt and personal rules. Claude retains its independent $20 monthly cap.
Codex uses the subscription-backed gateway; its quota is separate from the Claude API usage record.
The gateway has no queue or job database. Its Linux amd64 image pins `openai-codex==0.156.1`.
The initial model was `gpt-6.1-sol` / `medium`. The VPS catalog did not contain that identifier;
the correction uses the supported `gpt-6-sol` / `medium`, pending publication and a successful real turn.

## Completed release checkpoints

| Checkpoint | Verified evidence |
| --- | --- |
| Implementation `07b331ac` | Complete [branch CI 40188413825](https://github.com/ziyixi/todofy/actions/runs/40188413825) succeeded. |
| Same-source main release | [Run 40189217953, attempt 2](https://github.com/ziyixi/todofy/actions/runs/40189217953/attempts/2) succeeded. |
| Infrastructure | [Infra apply 40189320360](https://github.com/ziyixi/todofy/actions/runs/40189320360) succeeded. |
| Initial VPS release | [Run 40190513593](https://github.com/ziyixi/todofy/actions/runs/40190513593) verified the existing pair and the gateway ready. |
| Formal Mailsort release | [Run 40190637747](https://github.com/ziyixi/todofy/actions/runs/40190637747) succeeded. |
| Stage diagnostics `df8c1afc` | [Branch 40192102516](https://github.com/ziyixi/todofy/actions/runs/40192102516) and [main 40192473630](https://github.com/ziyixi/todofy/actions/runs/40192473630) succeeded. |
| Read-only check `856164de` | Complete [branch CI 40194175478](https://github.com/ziyixi/todofy/actions/runs/40194175478) and [main 40195176037](https://github.com/ziyixi/todofy/actions/runs/40195176037) succeeded. |

The first main attempt stopped on a Todofy deployment-record HTTP 404. Current metadata was checked,
then the original failed job was rerun successfully. No retry layer was added for that incident.

Infra apply created three Access resources and updated the path on the existing tunnel.

The initial gateway deployment is `7312772510`, with source `07b331ac`.
Newsletter, its configuration sync, the platform runtime and the gateway were all ready;
all five existing PVCs were Bound. These are workload/storage readiness observations, not inference proof.
The initial release used the `07b331ac` service images. Later gateway-only updates can carry their own
source SHA while unchanged workloads retain their verified source. Mixed source SHAs are supported.

The formal Mailsort readback retained the original Gmail and Claude secret names.
Both saved prompt fields compared equal to their previous values. Live mode and the daily/run
write limits of 150/10 remained unchanged. Secret-name checks do not read or verify secret values.

## Real inference remains unsuccessful

A real endpoint test used four synthetic messages and the same saved classification prompt.
Cloudflare Access and bearer authentication were exercised; an invalid-credential request returned 401.
An authenticated inference request returned `codex_unavailable` after about two seconds.
The response reported zero input/output tokens. This does not prove that no subscription usage or cost occurred.

The deployed `df8c1afc` diagnostics confirmed configuration, runtime startup, account and skills stages passed.
The failure was localized to the model stage. No successful structured classification answer was obtained.
Mailsort therefore remains on Claude; the failed tests did not trigger a provider switch or old-mail recheck.

## Read-only model availability check

`856164de` adds `CheckInference` to inspect runtime availability before another inference attempt.
It reads the account state and makes one `model/list` request with a limit of 100.
It exposes the configured model/effort, model `id`/`model`/`supported_efforts`, `has_more_models`
and an `authenticated` boolean, with a safe error code when metadata reading fails.
It excludes account names, credentials, descriptions and cursors, and does not invoke a model.
Production metadata at `2026-10-25T12:57:34.221Z` reported authenticated subscription state, no error and
one complete catalog page. It contained `gpt-6-sol` with `medium` support, and did not contain
`gpt-6.1-sol`. The original identifier came from the desktop model menu without VPS verification.
The gateway and Mailsort expected model are being corrected together; no automatic model fallback is added.

## Remaining acceptance

- [x] Record the production `CheckInference` result and available model/effort identifiers.
- [ ] Resolve the model-stage failure from that evidence and verify any resulting release.
- [ ] Obtain one real successful synthetic inference with strict message coverage and P1–P4 output.
- [ ] Select Codex through Mailsort settings, then read back the saved provider and current status.
- [ ] Verify Home and Fleet report the selected provider and gateway state accurately.
- [ ] Restore `AUTO_REPAIR=true` after the release and runtime checks pass.
- [ ] Revoke the temporary eight-hour helper authorization.

No item above is satisfied by CI success, a ready pod, authentication success or a zero-token failure alone.
Production inference, provider selection and any natural Gmail effects need their own evidence.

## Operator material

The operator retains a private local token file at `~/.config/todofy-infra/codex-gateway.token`, mode `0600`,
for future prechecks without `sudo`. Its contents are excluded from this record, Git and public logs.
All inference acceptance inputs are synthetic; no personal mail or credentials belong in this document.
