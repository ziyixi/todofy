# Codex monitor history, October 25–27, 2026

This is dated evidence, not a current runbook or a new production check. Active work is in
[HANDOFF](../../HANDOFF.md). The [fixed original record](https://github.com/ziyixi/todofy/blob/288e5ef7c9e3df3761b45b0e436b86503bf38cba/docs/history/codex-monitor.md)
retains the full receipts and intermediate notes; its old pending lists and commands are superseded.

## Recorded progression

- Initial process-lifetime statistics (`1e86e67`) passed branch/main publication. A real synthetic Codex call and
  the normal host observer reached Fleet/Home; opening the page did not itself invoke a model. Restart reset those
  initial counters.
- Durable daily usage (`0e3b78ed`) passed branch/main publication. UTC completion-day aggregates and eight bounded
  content-free samples survived reopening the SQLite store; thirty recorded days were exposed without guessing
  pre-instrumentation usage. A separate health read and browser selectors matched the recorded synthetic call.
- A staged rollout exposed an existing reconcile/proto-bound mismatch. A transition regression reproduced it and
  the explicitly reviewed output-rule correction fixed it; other compatibility guards remained enforced.

Local persistence/boundary tests, provider readiness and real synthetic inference had different scopes. No private
mail/task/Notion content was an acceptance fixture. This separate monitor was archived during the Router cleanup;
current usage ownership is [Model Router](../../model-router/README.md), not these retired paths or mount details.
