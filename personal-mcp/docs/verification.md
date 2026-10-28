# Personal MCP verification

What was actually tested, by date, with the owner's existing private App and connection. No real task, mail,
browsing record or Home fault was read or changed. The later Work, Watch and Recall release is recorded in
[work-memory verification](../../docs/work-memory-verification.md). The run-by-run record this page condenses is in
the repository history at `4ed50919` (`docs/personal-mcp-verification.md`).

## Connection gate

2026-10-21. Anonymous requests to `/mcp` receive 401 with a Bearer challenge that advertises the protected-resource
metadata; ChatGPT discovered dynamic client registration without a manual client ID. The first native subscription
failed because the callback host was `connectors.api.openai.com`, not the assumed `chatgpt.com`; the closed
diagnostic slot (phase, event name, callback host, safe error codes) showed it, and the exact host replaced the
assumption with a regression test. The accepted gate then verified the signed challenge, one test event delivered
once, and the Dot's reply naming that exact event ID and build. Repeating the request ID returned `repeated: true`
without a second delivery, and cleanup returned to zero subscriptions.
Evidence: [release of `422df6a0`](https://github.com/ziyixi/todofy/actions/runs/39555301186).

## Business release

2026-10-21. The existing App discovered 18 tools and five event types, and the private plugin skill read back
unchanged apart from its version. All four live sources reported success; subscribing delivered current events
only, never history. Repeating a task creation or Step request returned the same identities. A synthetic task
entered Must start only after its lead changed from 0 to 1; the source Alarm produced the event, the signed callback
was accepted once, and the Dot's execution data confirmed it. A unique synthetic Recall phrase returned no results.
Cleanup stopped every subscription and deleted the synthetic tasks. Not exercised: natural date transitions,
production Mail collection, real completions, real Recall content and a new Home fault.
Evidence: [release of `f5386a9d`](https://github.com/ziyixi/todofy/actions/runs/39568082826).
