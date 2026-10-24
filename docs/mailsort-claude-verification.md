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

The production key is planned as a single-workspace key with no Admin API access, written directly to the
Mailsort Worker. It is excluded from GitHub secrets, bootstrap maps and deploy overwrite. Key issuance awaits the
browser-required action-time confirmation; production has not switched yet.

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
