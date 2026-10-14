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

The four label mappings are one fixed array for this prototype. Production integration, arbitrary-column
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
