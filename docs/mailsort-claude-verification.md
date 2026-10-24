# Mailsort Claude rollout

2026-10-24. The owner selected Opus 5.5 medium after the [six-condition comparison](mailsort-claude-comparison.md)
and authorized implementation with a dedicated $20/month Claude workspace.

## Implemented

The existing Cloudflare Worker, SQLite object `mailsort-v1`, Alarm, Gmail grant and write ledger are retained.
Roughly hourly classification uses one structured Claude request for up to ten unread, unclassified messages.
P1 stays in Inbox; P2-P4 archive. Existing labels, read state, stars, message IDs and history remain.
No VPS or Codex runner was added. Existing classified mail is not automatically rechecked.

The maintained prompt now clarifies the value of personal periodic reports without sender-brand rules.
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
A branch CI gate, same-SHA main release, actual provider call and post-deploy status verification remain to be recorded.

## Real API and first release attempt

The built production client sent one batch of five synthetic messages to the real API. It returned
`claude-opus-5-5`, medium effort, 2,580 input tokens, 326 output tokens and zero reported thinking tokens.
The nominal cost was $0.01684; all five P1-P4 choices matched the synthetic expectations. These are integration
fixtures, not a mailbox-accuracy measurement. This out-of-app test is billed to the Mailsort workspace and is
not included in the app's own usage table.

Implementation SHA `a28e24abeebe85479793b026cbee5deba89528f7` passed the complete
[branch gate](https://github.com/ziyixi/todofy/actions/runs/40132337773).
The [first same-SHA main attempt](https://github.com/ziyixi/todofy/actions/runs/40140567311) stopped before upload:
the release preflight correctly refused the old undeclared `AI` binding. Build SHA drift was an ordinary release
difference, not the blocker. The existing exact binding-retirement list is being updated for Mailsort's intentional
AI removal; no broad bypass or manual Worker code deployment is used.
