# Planning UI

Plan, Focus and the Mail categories dialog of Tasks. Components and operation handling live here; Tasks owns
navigation, authentication, the estimate write and persistence of non-content view preferences. No
credentials, network origin or task deep link is stored in this package.

```tsx
import { PlanningApp, createPlanningActions } from "@ziyixi/planning-ui";
import "@ziyixi/planning-ui/styles.css";

const actions = {
  ...createPlanningActions({ plus: sendPlus, flowday: sendFlowday }),
  updateEstimate, // writes the task's duration in Tasks
};

<div className="planning-ui">
  <PlanningApp
    actions={actions} view="plan" language="en"
    onOpenTask={openTask} onOpenMail={openMail} onSettings={openSettings} onViewChange={changeView}
  />
</div>
```

Transports receive the root proto `HttpCall` and return a `Response`. Tasks sends `PlusService` calls to its
same-origin `/api/plus/v1/*` with CSRF, and FlowDay's focus methods to `/api/plus/flowday/*`; Todofy's
private Planning channel forwards only the methods Tasks uses. Host callbacks open the full task editor and
Tasks' Mail page. `snapshot`/`onSnapshot` keep confirmed content in page memory; `planView`/`onPlanView`
optionally remember IDs and view choices, never task text.

The package keeps the write ordering, confirmed timer state and pending-card rendering. It does not
synchronize task stores or own server state. CSS is compiled into Tasks and scoped to planning classes and
`.planning-ui`; Tasks' layout owns the outer width and spacing.

Run `npm ci`, `npm run typecheck` and `npm test`. The unit suite in `test/` covers the components, the
domain rules and the API mapping over a fake transport; Tasks' Playwright journeys
(`tasks/web/test/browser/planning-*.spec.ts`) cover them in the browser. The behaviour and the API used
for each operation are described in [docs/interface.md](docs/interface.md).

Tasks distinguishes ordinary tasks/subtasks from executable steps. Only `kind=step` or a task explicitly
marked **Schedule as a step** appears among calendar candidates. Planning state is the task's saved stage
and its planning flags (`waiting`, `parked`, `active`, …), never its ordinary tags. Dependencies determine
blocked status; Waiting remains available for something outside the task graph. The start-ahead field
accepts 0–365 calendar days and Start now opens exactly that many days before the deadline.

Focus uses FlowDay's existing server session and command receipts for count-up and 25/50-minute timers.
Reloads hydrate the same session; pause/resume keeps its original flow date. Visible pages read only the timer
once per minute and refresh the task view at account midnight. Finishing a pomodoro uses the existing atomic
FlowDay finish command, which caps recorded time even if the browser was closed when the countdown ended.
A task's estimate is its Tasks duration: the host supplies `updateEstimate`, which writes Tasks, and FlowDay's
mirrored copy is never read. Only FlowDay's local tasks keep an estimate of their own. A day queue write goes
straight to FlowDay's queue; it never waits for FlowDay's mirror to know the task.

Review keeps candidate columns together and gives Committed a separate full-width row of horizontal cards.
Plan's outcome, Step, Quick and calendar checkboxes use the same completion receipts and settlement as Focus;
calendar cards pass their own flow date. Quick actions always qualify as standalone, even when an older
response contains only the Quick flag. Ordinary labels do not imply planning properties.
