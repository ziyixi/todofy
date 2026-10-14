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
  parent, Bets and native priority marks are distinct without new status categories.
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
