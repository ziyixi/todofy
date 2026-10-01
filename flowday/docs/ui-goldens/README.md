# FlowDay UI Goldens

These screenshots are visual regression goldens for the app UI. They are not README figures; they cover product surfaces that are useful to review after UI polish, refactors, and timer changes.

Run from `flowday/web`:

```bash
npm run screenshots:ui
npm run screenshots:ui:check
```

`screenshots:ui` regenerates the committed PNG files in this directory. `screenshots:ui:check` renders fresh screenshots into `web/output/ui-goldens/current` and compares them against these committed goldens with the same small pixel-diff budget used by the README screenshot workflow.

The suite covers:

- main shell active timer in light and dark mode
- empty day canvas
- planning wizard add and capacity confirmation states
- task cards, completed rows, and sidebar sections
- manual time entry and Pomodoro picker popovers
- pop-out active, paused, and finished Pomodoro states
- misc time menu
- settings and export dialogs
- analytics daily, weekly, and work-pattern tabs
- 5-day view and collapsed sidebar
