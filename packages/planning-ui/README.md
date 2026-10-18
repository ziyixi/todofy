# Planning UI

Plan, Focus and Mail shared by Tasks and the Todoist Plus extension. Components and operation handling
live here; each application owns navigation, authentication and persistence of non-content view preferences.
No browser extension API, credentials, network origin or task deep link is stored in this package.

```tsx
import { PlanningApp, createPlanningActions } from "@ziyixi/planning-ui";
import "@ziyixi/planning-ui/styles.css";

const actions = createPlanningActions({ plus: sendPlus, flowday: sendFlowday }, undefined, "tasks");

<div className="planning-ui">
  <PlanningApp
    actions={actions} view="plan" language="en"
    destination={{ name: "Tasks", taskHref, projectHref }}
    onOpenTask={openTask} onSettings={openSettings} onViewChange={changeView}
  />
</div>
```

Transports receive the root proto `HttpCall` and return a `Response`. Tasks supplies same-origin owner
requests with CSRF; the extension supplies its existing bearer transport. The task store is selected
explicitly (`tasks` or `todoist`); references from another store are not silently accepted. Host callbacks
open the full task editor. `snapshot`/`onSnapshot` keep confirmed content in page memory; `planView`/
`onPlanView` optionally remember IDs and view choices, never task text.

The package retains the existing write ordering, confirmed timer state and pending-card rendering. It
does not synchronize task stores or own server state. CSS is compiled into the consumer, scoped to
planning classes and `.planning-ui` (or the extension's shadow host). Consumer layouts own their outer
width and spacing.

Run `npm ci`, `npm run typecheck`, and `npm test`. Todoist Plus's existing unit and packaged-browser
suite continues to exercise these same extracted components through its compatibility entrypoints.

Native Tasks distinguishes ordinary tasks/subtasks from executable steps. Only `kind=step` or a task explicitly
marked **Schedule as a step** appears among calendar candidates. Dependencies determine blocked status;
Waiting remains available for something outside the task graph. The native start-ahead field accepts 0–365
calendar days and Start now opens exactly that many days before the deadline.

Focus uses FlowDay's existing server session and command receipts for count-up and 25/50-minute timers.
Reloads hydrate the same session; pause/resume keeps its original flow date. Visible pages read only the timer
once per minute and refresh the task view at account midnight. Finishing a pomodoro uses the existing atomic
FlowDay finish command, which caps recorded time even if the browser was closed when the countdown ended.
A task's estimate is its Tasks duration: the host supplies `updateEstimate`, which writes Tasks, and FlowDay's
cached copy never replaces one. Only FlowDay's local tasks keep an estimate of their own. With Tasks, a day
queue write goes straight to FlowDay's queue; it never waits for FlowDay's mirror to know the task.
