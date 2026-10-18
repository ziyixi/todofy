# Todoist Plus (retired)

Todoist Plus was a Chrome extension, built from 2026-10-13, that added Plan, Focus and a Mailbox inside Todoist's
website and PWA. It called Todofy's `PlusService` on the hooks hosts with a per-device connection token, and
FlowDay's focus methods through Todofy. Todofy wrote Todoist, using planning labels the owner mapped on Todofy's
`/plus` page; FlowDay kept the day queue and the timer. Once Tasks hosted the same Plan, Focus and Mail natively
(the cutover of 2026-10-18), the extension remained only as a test host for the shared components.

On 2026-10-18 the owner removed it, with no compatibility window. The last commit with its source and
documents is `f6c08aaf` (`git show f6c08aaf:todoist-plus/README.md`); its releases are recorded in
[the retired handoff](todoist-plus-handoff-2026-10-17.md).

| Part | Replaced by |
| --- | --- |
| The extension (`todoist-plus/`), its WXT build, Chromium scenarios and ZIP releases | Plan, Focus and Mail in Tasks; the components and their unit tests in `packages/planning-ui`; Tasks' browser journeys `tasks/web/test/browser/planning-*.spec.ts` |
| Planning labels, the label mapping and `/plus` (ConfirmPlanMapping, UpdatePlanLabels) | Each task's saved stage and planning flags in Todofy's planning store; nothing to map |
| Connection tokens and the hooks-host routes (Issue/Read/RevokeExtensionConnection) | Tasks' owner Access login, Origin and CSRF, then Todofy's private Planning channel |
| The Mailbox (LookupMailItems, FileMailItem, DeleteMailItems, UpdateMailSettings) | Tasks' Mail page: ListMailItems, ConvertMailItem, DeleteMailSummaries, UpdateMailCategories |
| FlowDay's `FocusEntrypoint` and the extension's FlowDay proxy | FlowDay's `NativeFocusEntrypoint`, reached through the same Planning channel |
| `todofy/docs/todoist-plus.md` | [planning-api.md](../../todofy/docs/planning-api.md) |
| `docs/todoist-plus-verification.md`, `docs/todoist-plus-planning-prototype.md`, the extension's docs | Git history at `f6c08aaf` |

The nine retired RPCs and the messages only they used are listed in `proto/retired.json`. The planning store
(`plan_*`), the Bets, dependencies, lane orders and mail summaries are unchanged: Tasks uses them. Todofy's
migration `0012_drop_plus_idle.sql` drops the idle `plus_connections` and `plus_actions` tables, and the backup
restore tool skips them in older backups.
