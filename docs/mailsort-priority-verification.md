# Mailsort P1-P4 verification

Implementation: `a70ff257526e8baa3d47e783da1980fff9d9ce11`. The owner requested four actual Gmail labels;
P1 keeps Inbox, P2-P4 archive, and valid uncertainty becomes P1. The model's phishing/trust gates are removed.
Tasks Mail and its task priorities are separate and unchanged.

## Local checks

Worker lint/types and 124 unit tests passed; 69 real-SQLite/workerd cases passed, including actual maximum-path
CPU coverage with 2,000 priority examples and both views for six messages. UI lint/types, 62 tests and build passed.
The real local Wrangler smoke exercised all four labels, fallback, corrections, replay, undo, budget/quota,
CSRF and auth failure; all 62 synthetic Google requests matched the independent closed-operation table.
The 26 deployment/credential/config cases and 437 CI/config/proto guards passed (one existing skip). Proto lint,
API lint, schema and additive compatibility checks passed. Bundle budgets remain 140 KiB Worker and 67 KiB UI;
local measurements are 137.1 KiB and 56.8 KiB gzip respectively. No model, service, credential or budget was added.

A real Chrome tab exercised the isolated local UI's initializer and reload, confirming exactly four policy rows,
the three-page navigation and truthful setup completion. This used an empty synthetic mailbox and no production
credential. Local QA processes and the temporary tab were stopped after saving the screenshot.

## First implementation release

[Branch gate 40051440933](https://github.com/ziyixi/todofy/actions/runs/40051440933) passed on the exact implementation
SHA. The first attempt of this run failed only while installing WebKit's Ubuntu dependencies under Recall's
five-minute install limit. Rerunning failed jobs succeeded; no Recall code, deadline or test budget changed.
The earlier superseded branch run caught the website privacy test's old October 10 date; its assertion was updated
to October 23 without weakening the Limited Use/navigation checks.

[Same-SHA main release 40052652580](https://github.com/ziyixi/todofy/actions/runs/40052652580) passed, reusing the
complete green branch gate. Only Mailsort and the required website privacy page uploaded. The provider-verified
first Mailsort Worker version is `b01a5f98-0eee-43ca-bfe9-1c121506ca11`; GitHub Deployment `7292659715` reports
`success` at `2026-10-24T02:06:30Z`, after running identity/configuration/persistent-resource checks.
The production owner page independently shows the three tabs and fixed P1-P4 policy, with its preexisting
正式 mode and writable Gmail grant. The public privacy page independently shows the new four-label behavior and
October 23, 2026 date in Chrome; its Limited Use statement is intact.

## Production cutover

Pending the browser tool's action-time confirmation for permanent removal of the old managed labels and learning.
The code is released; the owner initializer has not been clicked in production. The four rows truthfully show
等待初始化. No real message body was read for acceptance and no mail/label/model/budget mutation was made by the
agent before that final confirmation. New mail may register as pending while setup is incomplete.

The initializer itself deletes only frozen old managed label IDs, verifies the four new actual Gmail IDs/names,
and preserves every message, unread/star state and Inbox position. Old decisions/ledgers remain historical;
learning and future classification start from the recorded cutoff without advancing an existing Gmail cursor.
Record actual source read-back after the authorized initializer completes. Synthetic tests do not establish the
result of a later real incoming mail.
