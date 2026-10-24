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
