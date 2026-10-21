# Planning UI

Plan, Focus and the Mail categories dialog of Tasks. Components and operation handling live here; Tasks owns
navigation, authentication, the estimate and completion writes and persistence of non-content view
preferences. No credentials, network origin or task deep link is stored in this package.

```tsx
import { PlanningApp, createPlanningActions } from "@ziyixi/planning-ui";
import "@ziyixi/planning-ui/styles.css";

const actions = {
  ...createPlanningActions({ plus: sendPlus, tasks: sendTasks }),
  updateEstimate, // writes the task's duration in Tasks
  completeTask, // completes in Tasks, which settles the Focus day in the same write
};

<div className="planning-ui">
  <PlanningApp
    actions={actions} view="plan" language="en"
    onOpenTask={openTask} onOpenMail={openMail} onSettings={openSettings} onViewChange={changeView}
  />
</div>
```

Transports receive the root proto `HttpCall` and return a `Response`. Plan, the tasks' planning facts and
dependencies, and Focus are Tasks' own `TasksUiService`, sent to its same-origin `/api/tasks/v1/*`: a load is one wave
of GetPlan, ListTasks pages, ListFocusDays and GetFocusTimer, and every planning write is one UpdateTask, ReorderTasks
or UpdateWeeklyBet, sent under the etag Plan holds with no read first. Only the weekly review's two Todofy facts (ReadWeeklyReview, read when the review opens) and the
Mail categories go to `/api/plus/v1/*` with CSRF, which Todofy's private Planning channel forwards. Host callbacks
open the full task editor and Tasks' Mail page. `snapshot`/`onSnapshot` keep confirmed content in page memory; `planView`/`onPlanView`
optionally remember IDs and view choices, never task text. `onSession` reports whether a Focus session exists, and
`background` lets the host keep the app mounted behind its other pages, where it renders only the Focus mini timer
(a Document Picture-in-Picture window) and keeps it working. `idlePause`/`onIdlePause` are the host's per-device
Pause when away setting: where the browser has the Idle Detection API, a running count-up pauses in Tasks at the
moment the owner left, and on return Focus asks whether to count that time (`src/idle-pause.ts`,
`src/useIdlePause.ts`).

The package keeps the write ordering, confirmed timer state and pending-card rendering. It does not
synchronize task stores or own server state. CSS is compiled into Tasks and scoped to planning classes and
`.planning-ui`; Tasks' layout owns the outer width and spacing. The mini timer's own stylesheet
(`src/mini-timer.css`) goes only into its window, with the page's computed tokens.

Run `npm ci`, `npm run typecheck` and `npm test`. The unit suite in `test/` covers the components, the
domain rules and the API mapping over a fake transport; Tasks' Playwright journeys
(`tasks/web/test/browser/planning-*.spec.ts`) cover them in the browser. The behaviour and the API used
for each operation are described in [docs/interface.md](docs/interface.md).

Tasks distinguishes ordinary tasks/subtasks from executable steps. Only `kind=step` or a task explicitly
marked **Schedule as a step** appears among calendar candidates. Planning state is the task's saved stage
and its planning flags (`waiting`, `parked`, `active`, …), never its ordinary tags. Dependencies determine
blocked status; Waiting remains available for something outside the task graph. The start-ahead field
accepts 0–365 calendar days and Start now opens exactly that many days before the deadline.

Focus keeps its day queues, the one timer and time records in Tasks (`proto/tasks/ui/v1/focus.proto`). The
timer counts up by default or runs a 25/50-minute pomodoro; Start counts on Tasks' today and keeps the step's
area on its record, reloads hydrate the same session, and pause/resume keeps its day. Visible pages read only the timer once per minute and refresh the
task view at account midnight. Stop and a pomodoro's Finish save the session as one record of whole minutes;
Finish caps it at the target and count-up stops at four hours, even if the browser was closed. Each queue
change is one `MoveFocusStep`, and every write keeps its request ID until confirmed, so a lost answer replays.
`readFocus` reads any range in reads of at most seven days, and records are added, changed and deleted with
`addEntry`, `updateEntry` and `deleteEntry`. Focus has Day, Week and Month views with day navigation: each
card's one time number is its logged time, which opens the day's records (`FocusEntries`); Week and Month
show logged time by area, steps done and where the time went (`focus-stats.ts`). Only today's steps run,
complete and reorder by their whole row; other days are read-only. A header checkbox shows the day's
completed steps. Plan and Focus both count from Tasks' today (`PlanState.today`, `FocusState.date`). A task's estimate is its Tasks
duration: the host supplies `updateEstimate`, which writes Tasks and answers the saved duration
and the task's new etag (`{ estimate, etag }`). A Step opens a panel that sets only its time (`StepEditor`); tasks open the full planning
panel.

Review keeps candidate columns together and gives Committed a separate full-width row of horizontal cards.
Every Plan and Focus card's left edge is its area's colour (Work slate, Personal ochre, Unassigned none), and
the area filters' Work and Personal dots are the legend.
Plan's outcome, Step, Quick and calendar checkboxes complete like Focus, in one Tasks write with a Focus
day: calendar cards pass their own day, the rest Focus's. A retry resends the first request ID and day. A completed calendar
Step stays in its day after the open ones, in Focus's done style, outside the day's total; its title opens Tasks' own
dialog, where it can be reopened. Quick actions always qualify as standalone, even when an older
response contains only the Quick flag. Ordinary labels do not imply planning properties.
