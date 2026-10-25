# Mailsort Codex verification

Mailsort now persistently selects VPS Codex with `gpt-6-sol` / `medium`.
A real synthetic inference through the production endpoint succeeded, and the saved prompts and write limits survived the switch.
Natural Gmail classification and its mailbox effects have not yet been observed; operator cleanup is complete.

## Successful real inference

At `2026-10-25T13:11:21.678Z`, the production TypeScript `classifyWithCodex` client completed a real request
through Cloudflare Access and the existing tunnel, using the same saved classification prompt.

| Observation | Result |
| --- | --- |
| Model and effort | `gpt-6-sol` / `medium` |
| Reported usage | 6,598 input tokens; 202 output tokens |
| Elapsed time | About 5.3 seconds |
| Strict result coverage | All four synthetic message IDs, exactly once |
| Returned priorities | P1 / P2 / P4 / P4 |
| Incorrect bearer | HTTP 401 |

Only synthetic messages were used. This acceptance request read no real mail and made no Gmail writes.
It verifies the production inference path, not mailbox accuracy or a naturally scheduled Mailsort batch.

## Provider selection and preserved settings

The owner-authorized switch was made through the real Chrome settings UI by clicking **VPS Codex**.
The settings API then returned `classification_provider=codex`, `mode=live`, and daily/run write limits of 150/10.
Every settings field except provider and etag equalled the pre-switch baseline.
After page reload, Codex remained selected and both saved prompt fields matched their original text exactly.

The classifier status reported `configured=true`, model `gpt-6-sol`, effort `medium`, and
`next_batch_time=2026-10-25T14:14:52.607Z`. It still had no `last_success_time` at this observation.
The direct synthetic client call above is separate from the existing DO queue's natural classification record.
No old-mail reclassification was started for acceptance.

Mailsort retains its Worker, SQLite Durable Object, Alarm, Gmail grant and write ledger.
The selector affects the next batch; both providers use the same saved base prompt and personal rules.
Claude retains its independent $20 monthly cap and historical usage. Codex uses the subscription-backed gateway.
Newsletter's business mode, budget and historical state were not changed.
The gateway has no queue or job database; its Linux amd64 image pins `openai-codex==0.156.1`.

## Release evidence

| Checkpoint | Evidence |
| --- | --- |
| Model correction `3e4c6b2f` | Complete [branch CI 40195966957](https://github.com/ziyixi/todofy/actions/runs/40195966957) succeeded. |
| Same-source main release | [Run 40196225288, attempt 2](https://github.com/ziyixi/todofy/actions/runs/40196225288/attempts/2) succeeded. |
| Final read-only reconciliation | [Run 40197045485](https://github.com/ziyixi/todofy/actions/runs/40197045485) succeeded across all jobs. |

The first model-correction main attempt stopped on Mailsort's Cloudflare asset-upload-session error 10013.
The original job succeeded when rerun unchanged; no retry layer was added.
Both original GitHub operational switches have been restored to `true`.

The initial [Infra apply 40189320360](https://github.com/ziyixi/todofy/actions/runs/40189320360) created three Access resources
and updated the path on the existing tunnel. The [first VPS release 40190513593](https://github.com/ziyixi/todofy/actions/runs/40190513593)
recorded gateway deployment `7312772510`, source `07b331ac`: Newsletter, its configuration sync, the platform runtime
and the gateway were ready, and all five existing PVCs were Bound.
Later gateway-only releases can carry a separate source SHA while unchanged workloads retain their verified source;
the deployment contract supports these mixed source identities.
The original Gmail and Claude secret names remained present; their values were not read for this check.

## Initial model mismatch

The original `gpt-6.1-sol` identifier was an implementation assumption taken from the desktop menu without VPS verification.
Its real request failed at the model stage with `codex_unavailable`; zero reported tokens did not establish zero usage or cost.
The deployed read-only `CheckInference` check (`856164de`, [main 40195176037](https://github.com/ziyixi/todofy/actions/runs/40195176037))
returned `authenticated=true` and a complete catalog (`has_more_models=false`), omitted that identifier, and confirmed
`gpt-6-sol` supports `medium`, which led to the fixed-model correction without adding fallback behavior.

## Home and Fleet observations

At 13:19 UTC, Home's tool readback reported `fleet`, `mailsort` and `codex-gateway` all `ok`,
with `checked_at=2026-10-25T13:17:46.978Z`, zero recorded failures and `topSignals=[]`.
The Home UI's backend-services list contains **Codex 推理**; its service-name DOM was confirmed.
The actual row text is `Codex 推理正常` and links to the existing operations view.

Home also retained an account-level `config_drift` attention item, activated at 03:30 UTC with three
account changes. It was not dismissed or treated as a new-service failure; the final independent CI comparison
reports the managed Infra and Worker configurations clean. That attention needs its own account-view investigation.

## Cleanup and observation boundary

The temporary helper reported `removed`, deleting its sudoers entry and root-owned program directory.
Its owner-side installer and private intermediate files were removed. No service was stopped by cleanup.
A final VPS inspection kept all four Deployments ready and all five PVCs Bound. Gateway image is pinned to
`sha256:d10f573d53af082653e50fa56cf5590fbf9da1a2e28e644cb33a0dea319ebc93`; Newsletter and platform retained their earlier accepted images.
The final reconcile reports VPS/Workers clean and Infra `in_sync` with 42 no-op resources.

A natural Mailsort Codex batch and its actual Gmail effects remain separate, unobserved evidence.
No reminder or automatic old-mail recheck was added for this.

The operator intentionally retains `~/.config/todofy-infra/codex-gateway.token`, mode `0600`,
for future prechecks without `sudo`. Its contents stay outside this record, Git and public logs.
No personal mail or credentials belong in this document.
