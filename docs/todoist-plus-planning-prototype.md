# Todoist Plus planning prototype

The local prototype is in `todoist-plus/design/` on `codex/plus-planning-prototype`.
It uses synthetic outcomes and in-memory queues. Reloading resets the demo. It does not call Todoist,
Todofy or FlowDay, read a connection, or write any persistent data. The installed extension is unchanged.

Run with Node.js 26:

```sh
cd todoist-plus
npm run prototype
```

Open `http://127.0.0.1:18795/` in Chrome. Review has four ordinary planning columns; Week shows all
five work and three personal commitments together. Select a commitment to see its small steps.
Use the grip to move outcomes between columns, or steps into days and positions. Calendar buttons
select a previous/next week; narrow windows keep the full-week day strip above three or one day.
Click a task for local title, planning, priority and estimate edits. Click outside or press Escape to close.

The four columns keep stable identities. Their label names can be edited through Board labels and are
shown in each Review header; this local mapping resets on reload. Production integration, arbitrary-column
configuration, Monday rotation and task creation are not implemented by this prototype. Existing label
names remain unchanged. The owner separately authorized creation of one empty `quarter` label; no actual
task was assigned to it.

## Verification

Actual Chrome native pointer checks passed for Quarter → Month → Week → Quarter, a step into Friday,
Friday → Tuesday insertion, and Tuesday reordering. DOM checks confirmed destination, source removal and
the resulting order. Dropping onto a narrow-window date button selects that day and shows the new card.
Task-title clicks opened the correct parent editor; clicking outside closed it. Next/current week navigation
returned the expected date range. All eight commitments were visible together in Week.

Widths checked: 2560 px (seven days), 1440 and 1000 px (three days), 700 px (one day). None had horizontal
overflow. Light and dark rendering were inspected. The prototype generated no console errors; two observed
errors came from the existing Zotero extension, which was not changed. Chrome sizing was reset afterward.

Typecheck, lint, 39 tests (including four new planning-state regressions), and the standalone Vite build pass.
An independent source review confirms no new dependency, network, credential, storage, worker or backend path.
These checks validate a local UI prototype, not production integration or persisted scheduling.

Synthetic screenshots and the private reference capture remain outside Git in
`/private/tmp/plus-planning-prototype-acceptance/`. The source capture contains private tasks and must not
be committed, published or reused as a fixture. See `todoist-plus/design-qa.md` for the visual comparison.

## October 14 feedback

Bets are now two independent current-week goals (work and personal), displayed above Review/Week.
Their editing does not change commitments or queues. They are not candidate stages, card priorities or
individual task toggles. The date on the goal heading identifies the current demo week when browsing another week.

Focus Start now opens a visible local stopwatch with elapsed time, Running/Paused and Pause/Resume/Stop.
One session stays in memory while changing views. Stop does not complete a task; completing its step stops
the session. The control strip remains present even if that step is no longer in the displayed daily queue.

Board labels has four editable names with suggestions. Saving trims names and identifies empty or duplicate
column mappings. It retains column IDs and does not move tasks. Custom labels are only simulated names;
this UI does not create, rename or bind real Todoist labels.

Local checks pass: 45 tests, types, lint and the standalone build. Additional Chrome feedback evidence is
kept outside Git in `/private/tmp/plus-prototype-feedback-20261014/`.
Chrome confirmed the new goal title without changing the eight commitments; custom Quarter mapping was
visible in the column header and retained on reopening the panel. A conflicting Week mapping stayed open
with a specific error. The clock reached 00:01:15, froze at 00:01:16 when paused, and continued across views
in a second resumed run. Stop left the task unfinished; completing the active step cleared the stopwatch.
The tested 1000 px Review and active-timer Focus layouts had no horizontal overflow; sizing was reset.
