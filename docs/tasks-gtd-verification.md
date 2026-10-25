# Tasks GTD execution review: verification

## Release

Implementation `cb6e8c810c1f836decd2cdee9beb8708ada32699` passed the complete
[branch CI 40176734141](https://github.com/ziyixi/todofy/actions/runs/40176734141), then the
[same-SHA main release 40177554343](https://github.com/ziyixi/todofy/actions/runs/40177554343).
Only Tasks and its proto consumer Personal MCP uploaded; other application and VPS releases were skipped.

| Application | Verified GitHub Deployment | Provider version |
| --- | --- | --- |
| Tasks | 7310763434 | `0a056945-5c9c-4f62-b61a-25bee85a6394` |
| Personal MCP | 7310771205 | `d1193235-0f02-40b7-8389-31de93f4d227` |

Both deployment statuses are success. The provider probe read both versions at 100%, with this exact
BUILD_SHA. Tasks migration `0010_gtd_report.sql` applied and the subsequent provider probe found no pending
D1 migration. The existing database `79a1f345-1183-46c3-bc6a-651be106f90c` and `tasks-backups` bucket identity
were preserved. No Worker configuration, Access policy, secrets, external dependency or paid plan changed.

## Local and CI evidence

- Tasks Worker: 72 unit tests and 152 workerd/D1 tests passed. The final ten report tests were also rerun after
  the optional-date default was aligned with Focus's current-week convention.
- Planning UI: 321 tests across 39 files passed after removing the retired statistics modules/tests/CSS.
  Existing day, timer, mini timer and away-pause coverage remains.
- Tasks web: 112 unit tests, TypeScript, ESLint and production build passed.
- Full Chromium suite: 141 journeys passed, including real Step completion, record editing, Plan/Focus dragging,
  PWA, cached editor geometry, Goals, timer/mini/away behavior and the new GTD journeys.
- Restore tooling: 19 tests passed; both new small GTD tables participate in schema-checked backup/restore.
- Complete branch CI also passed shared packages, root proto/lint/breaking checks, contracts and every declared
  source consumer. Main reused the exact green commit; no source amendment occurred between check and release.

Reporting tests distinguish Task/Step/Routine, Standalone/Quick, inherited task area and saved time-record area;
check account-local dates across DST; retain weekly membership and removed/moved Step membership; omit
incomplete historical Task denominators; and keep complete totals while limiting related details to 100 rows.
An indexed-read regression adds 3,000 unrelated historical records and verifies the bounded period still reads
fewer than 600 rows in its small fixture.

The authenticated 31-day CPU fixture uses 930 time rows and 100 long CJK Task/parent titles. Local reference
medians were 6.58 ms for the first request, 3.80 ms warm and 3.56 ms for the inherited Work filter. The original
CPU budgets were not raised. The Worker measures about 167.1 KiB gzip; its documented project size ratchet is
175 KiB (previously 165), far below the unchanged Free script-size limit. The GTD UI remains lazy at about
5.6 KiB gzip. Main/shared JavaScript is about 341 KiB gzip, slightly below the preceding build; retired statistics
also reduced the shared stylesheet. No new chart library, service, persistent cache or periodic query was introduced.

## Browser and production acceptance

The [visual review](../tasks/design-qa.md#gtd-execution-review) includes the three approved designs, native
Chrome captures and paired comparisons. Fixtures/screenshots contain synthetic content only. The final
Chromium journeys also captured desktop at the mock's 1489×1056 viewport and phone at 375 px.

After deployment, the existing authenticated owner Chrome session was used read-only:

- GTD exposes Overview, Completion and Time, with no legacy mail-age trends or error.
- Time's Month view loads the calendar. Work selection and Month stay selected when changing to Completion.
- Selecting today's calendar cell opens `#/focus/YYYY-MM-DD`. The daily toolbar and View statistics are present;
  the former Focus statistics-mode tabs are absent. Returning through View statistics opens GTD Time.
- The final user-facing tab is GTD Overview. No task title, description, mail, time-record content or credential
  was printed or saved. No Task/time mutation was invoked for production acceptance.

## Limits kept explicit

The first migration week and older periods do not have a trustworthy original commitment denominator; they show
completion counts. Full Task rates begin with the first fully recorded week. Classification/estimates beside
history use current task properties. The selected period's completed counts replace the mock's unsupported
four-week percentage baseline, and Completion reuses the same count chart. Routine time is already included
in recorded time. Metric definitions and interfaces are in [GTD](../tasks/docs/gtd.md).

The next natural weekly production backup containing the new tables has not been observed. This release
verified schema/restore behavior locally; it did not create a new backup platform or force an application run.
Work remained in the isolated checkout. The shared Google Drive checkout was not modified.
