# Planning prototype QA

final result: passed

Scope: the owner's selected Review/Week redesign, keeping the current Todoist visual language.
The new information layout is intentional; this is not a pixel clone or production acceptance.

Source visual truth: local `source-todoist-private.png`, captured from the installed Plus Plan view.
Implementation: local `08-week-final-wide.png`, with synthetic tasks. Both were opened together in the
same comparison input. CSS viewport was 2560 × 873; source pixels were 2560 × 873 and implementation
pixels 2545 × 868 (capture scrollbar bounds). Both were displayed at 2048 × 698 for the full-view check;
no precise pixel-distance claim is made. Task data, the simulated today date and the two information
layouts differ intentionally. Private source pixels remain outside Git.

## Findings and corrections

- P2: eight fixed-height Review cards put the last card just below the original viewport. Cards now use
  natural height with a 64 px minimum, 14 px titles and 12 px metadata; all eight are visible at the normal
  wide viewport. Week's overview uses four columns and two rows.
- P2: the 1440 px window still squeezed seven calendar columns. The three-day threshold is now 1280 px
  of calendar width; post-fix cards are 342 px wide. The full-week selector remains available, with no
  horizontal overflow at 1440, 1000 or 700 px. `03-week-1440.png` is the pre-fix view;
  `04-week-1440-fixed.png` and the final capture show the correction.
- P2: step-title callbacks initially used a step ID in the parent-only editor. They now resolve the
  parent ID; actual Chrome opened the populated editor and its estimates. Outside-click dismissal passed.
- The sidebar restores Todoist's Add task, Filters & Labels and More placements. These native controls
  are visual context only; Review, Week, Focus and the prototype's own controls are interactive.

## Visual checks

- Typography: the observed native system-font stack is retained. Task titles are 14 px; metadata is 12 px,
  sidebar text 13 px. Title precedes a short context line; long ancestor paths no longer compete with it.
- Layout: all commitments are grouped above scheduling, and only the selected parent's steps expand.
  Full-width days, ordinary dividers and restrained card borders replace the permanently narrow pool.
- Tokens: existing green accent, pale selection, light backgrounds and dark tokens are reused. Selected
  parent and native priority marks are distinct without new status categories.
- Assets: existing Lucide icons and ordinary form primitives; no raster assets or generated artwork.
- Copy: English task and planning controls match the current Todoist locale; all task content is synthetic.

Focused card rendering was inspected in the 1440 px capture in addition to the full-view comparison.
At that size titles, parent context and estimates were readable without the full-view downscaling.
Dark rendering is recorded in `06-week-dark.png`; single-day rendering in `05-week-700.png`.

Native mouse drags confirmed lane changes, day changes and insertion order. The existing library supplies
160 ms drop motion; no frame-rate benchmark was performed. View switching, date selection, week navigation
and editor dismissal were checked. No prototype console errors appeared; unrelated Zotero errors were left
alone. Browser viewport overrides were reset. No actionable P0/P1/P2 issue remains in the checked scope.

Remaining boundary: saving to the real services, label-role configuration and automatic weekly rotation
await a separate implementation. Reload resets the local synthetic state.

## October 14 feedback correction

The owner's requested reference change makes Bet an overall weekly goal. The two editable current-week
goals now sit above Review/Week, with larger goal text; task-level Bet marks and toggles were removed.
The execution commitments remain eight. Quarter and the other columns have editable local label names,
with the saved mapping displayed in the header. The modal is four simple inputs, not a column/rule builder.

The old timer only changed its icon. The revised Focus shows one active strip with elapsed HH:MM:SS,
Running/Paused and Pause/Resume/Stop. Its strip remains reachable when the item leaves the daily queue.
Actual Chrome elapsed time advanced, paused unchanged, and continued when switching views; Stop and
completion behaved separately. The 1000 px active strip did not overflow horizontally.

Feedback captures: `02-weekly-goals.jpg`, `01-timer-paused.jpg`, `03-label-mapping.jpg` in
`/private/tmp/plus-prototype-feedback-20261014/`. The 2560 × 873 Review frame kept the final commitment
bottom at 868 px after natural card minimum was reduced to 60 px. Existing system fonts/tokens and icons
remain in use; goals are 16 px and the clock is 22 px. No actionable P0/P1/P2 issue remains in these checks.
These are local prototype changes; real services, tasks, labels and the installed extension were not modified.

## October 15 theme, safety and polish

The owner approved the UI research's safety, theming and polish items. This is a production change, not
a prototype; the checks below used the real MV3 build, synthetic tasks and Doist's public theme CSS
(`@doist/product-libraries-tokens` 1.4.2), not live Todoist values.

- Tokens: the earlier green accent and pale selection were Kale fallbacks behind two token names that no
  Todoist theme defines. Every colour now reads the token with Todoist's own role (accent text, primary
  fill with its on-colour, selected row with its text, surfaces, muted, lines, hover, warning, priorities,
  overlay, shadows). Kale looks nearly the same; Default, Blueberry, Dark and Tangerine now match their own
  sidebar. Every text pair Plus composes keeps 4.5:1 and every indicator line 3:1 in all nine public
  themes (review follow-up below).
- Copy and icons: "Paused" is a state and "Pause" a button; "1 step"; natural Chinese counts; one
  "Planning labels" name; 需要关注; a calendar-clock for the start window (the flag means priority in
  Todoist); chevrons on expandable rows; no inert '+' under planned days.
- Dates: "Week 42 · from Oct 12" and "Mon, Oct 12" (Chinese "第 42 周 · 10月12日起", "10月12日周一").
- Consistency: weights 600, nothing under 12 px, one 1.5 px icon stroke, one grip size, 32 px controls,
  aligned FlowDay rows and a timer bar centred on the Plus column.
- Recovery: a render failure leaves one line, "Back to Todoist / Reload"; native Todoist is never left
  hidden without its replacement.

Before/after captures (Kale in English and Chinese, Default, Blueberry, Dark and Tangerine; review,
week, focus, collapsed sidebar, weekly review, task editor, native details and options) were reviewed
locally and stay outside Git. No horizontal overflow or console errors were seen; the live Todoist page
was not opened.

Review follow-up, same day. Measured on the nine public themes, these were below target and are fixed:
today's day number in Week was accent text on the selected fill (3.83:1 in Blueberry); muted text on
selected cards and the selected day heading was 4.42:1 in Moonstone; the error line's links were accent
on the lane surface (4.10:1 in Dark). All text on the selected fill now uses Todoist's selected text
colour, and the error links use the body text with their underline. Drag indicators (insert line, drop
borders) use the accent instead of the primary fill, which was 1.65:1 in Tangerine. Kept on purpose: the
focus ring stays on the accent rather than Todoist's focus token (about 2:1 in Dark); the warm Dark
lanes are Todoist's own tinted tertiary background, as every theme's is; P2 orange and P4 grey rings
(2.41–2.85:1 on light themes) are Todoist's own priority colours. The Plan/Focus label offset seen in
one review fixture came from a native gap that fixture added; the live check in docs/verification.md
reads the real offset.
