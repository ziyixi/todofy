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
