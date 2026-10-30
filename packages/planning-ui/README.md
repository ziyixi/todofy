# Planning UI

Plan, Focus and the Mail categories dialog of Tasks. Components and operation handling live here; Tasks owns
navigation, authentication, the estimate and completion writes and persistence of non-content view
preferences. No credentials, network origin or task deep link is stored in this package.

```tsx
import { PlanningApp, createPlanningActions } from "@ziyixi/planning-ui";
import "@ziyixi/planning-ui/styles.css";

const actions = {
  ...createPlanningActions({ tasks: sendTasks }),
  updateEstimate, // writes the task's duration in Tasks
  completeTask, // completes in Tasks, which settles the Focus day in the same write
};

<div className="planning-ui">
  <PlanningApp
    actions={actions} view="plan" language="en"
    onOpenTask={openTask} onOpenMail={openMail} onOpenGtd={openGtd} onSettings={openSettings}
    onViewChange={changeView}
  />
</div>
```

The transport receives the root proto `HttpCall` and returns a `Response`. Plan, the tasks' planning facts and
dependencies, Focus, the weekly review's two facts and the Mail categories are Tasks' own `TasksUiService`, sent to
its same-origin `/api/tasks/v1/*`: a load is one wave of GetPlan, ListTasks pages, ListFocusDays and GetFocusTimer;
every planning write is one UpdateTask, ReorderTasks or UpdateWeeklyBet, sent under the etag Plan holds with no read
first; the review reads GetWeeklyReview when it opens (the review task and the mail Todofy still holds). Host
callbacks open the full task editor and Tasks' Mail and GTD pages. `snapshot`/`onSnapshot` keep confirmed content in page memory; `planView`/`onPlanView`
optionally remember IDs and view choices, never task text. `onSession` reports whether a Focus session exists, and
`background` lets the host keep the app mounted behind its other pages, where it renders only the Focus mini timer
(a Document Picture-in-Picture window) and keeps it working. `idlePause`/`onIdlePause` are the host's per-device
Pause when away setting: where the browser has the Idle Detection API, a running count-up pauses in Tasks at the
moment the owner left, and on return Focus asks whether to count that time (`src/idle-pause.ts`,
`src/useIdlePause.ts`). `focusDay` opens a date selected in Tasks GTD; daily navigation then stays local.

The package keeps the write ordering, confirmed timer state and pending-card rendering. It does not
synchronize task stores or own server state. CSS is compiled into Tasks and scoped to planning classes and
`.planning-ui`; Tasks' layout owns the outer width and spacing. The mini timer's own stylesheet
(`src/mini-timer.css`) goes only into its window, with the page's computed tokens.

## Checks and behavior

```sh
bazel test //packages/planning-ui:check
bazel build //packages/planning-ui
```

The package `check` script uses the same suite. The typecheck and test scripts also delegate to Bazel. A frozen pnpm workspace install supports source-level development. Unit tests cover components, domain rules and API mapping over a fake transport; Tasks' browser
journeys in `tasks/web/test/browser/planning-*.spec.ts` cover the complete interaction.

[Interface behavior](docs/interface.md) defines Plan/Focus layout, execution kinds, readiness and dependencies,
weekly rollover/review, completion, timer and record editing, mini timer, idle pause and ordered writes. It is the
shared behavior reference; [Tasks readiness](../../tasks/docs/planning-readiness.md) defines the host's readiness
rules. The controlled `ExecutionFields` export is also used by Tasks' native task editor.
