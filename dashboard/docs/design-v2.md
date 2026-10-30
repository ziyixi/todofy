# Home view and observation guide

The completed v2 migration is documented by the current sources below. This page is navigation, not a second
runtime specification.

| Topic | Current reference |
| --- | --- |
| Registry, ownership and source reads | [Current design](design.md#2-configuration-and-observations) |
| Storage and mutation receipts | [State](design.md#3-state-and-serialization) |
| Guard, canary and daily digest | [Scheduled decisions](design.md#5-scheduled-decisions) |
| Four views, typed API, ETags and budgets | [Owner API and UI](design.md#6-owner-api-and-ui) |
| Configuration drift and account history | [Configuration drift](design.md#7-configuration-drift) |
| Reminder dismissal and recovery | [Reminder control](design.md#8-reminder-control) |
| Personal MCP's cached read | [Private read](design.md#9-private-cached-home-read) |
| Newsletter evidence, per-service controls and exact registration | [Dashboard state and operations](../../docs/dashboard-state.md) |
| Dated verification | [Verification](verification.md) |

The API remains `dashboard.ui.v1`. Frozen wire fixtures and the compatibility table retain their own meanings;
old rollout steps and prototype layouts are not current instructions.
