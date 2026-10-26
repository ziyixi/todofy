# Classification interval verification

Released source `42897d14ef61d1cdd2f7592a2b89a4b29075fa2e` on 2026-10-26 UTC.

- [Full branch gate](https://github.com/ziyixi/todofy/actions/runs/40258762062): success.
- [Same-source main release](https://github.com/ziyixi/todofy/actions/runs/40259875945): success.
- [Matching resource/configuration reconcile](https://github.com/ziyixi/todofy/actions/runs/40260037384): success,
  including inventory, VPS and resolved-infrastructure gate.
- GitHub deployment 7322823236 verified Worker version `13bb8f8a-6677-4052-a709-9fe56e5b04e5` at 02:37:20 UTC.

Real Chrome Settings showed 15 minutes selected with live mode and VPS `gpt-6.1-sol` medium unchanged.
After the existing Alarm adopted the missing legacy field, the displayed normal next batch changed from
20:35 to 19:50 PDT on October 25. Gmail maintenance continued on its separate five-minute schedule.
The page was reloaded to verify the visible setting and actual next-batch time; no manual classification,
provider toggle, prompt edit or historical unread reclassification was invoked for acceptance.

Local verification passed 236 Worker unit tests, 119 real workerd/SQLite cases and 111 UI tests, along with
lint/types, UI build/budget, Wrangler smoke using synthetic Gmail/Claude/Codex and proto checks.
Coverage includes the persisted choices, one-time legacy adoption, normal-wait adjustment, request replay,
retry/quota preservation and changing 15 to 60 during an awaited model request. No new
scheduler or extra database was introduced. The Worker is 148.7 KiB gzip under the existing 150 KiB budget.

The first full CI attempt's unchanged report-Alarm fixture timed out. Its local module and same-source
runtime rerun passed; the original initial-tick cause was not established. The CI collector also mixed an
old failed JUnit artifact with a new same-name result. The existing uploader now uses its native overwrite
option, and final full CI passed. No report business logic or test timeout was changed.
