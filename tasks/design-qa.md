# Approved Tasks interfaces

Each approved design, with synthetic content only, and the commit that implemented it. Every review compared the
design with a real Chromium rendering at the same viewport and ended with no open P0, P1 or P2 finding.

| Interface | Approved design | Implemented in |
| --- | --- | --- |
| Task editor and sidebar | [task-interface-approved.png](docs/images/task-interface-approved.png) | `4dd8fe46`, with the child-entry focus fix `53e0c2b1` |
| Goals | [goals-approved.png](docs/images/goals-approved.png) | `46839255` |
| GTD Overview, Completion and Time | [Overview](docs/images/gtd/overview-approved.png), [Completion](docs/images/gtd/completion-approved.png), [Time](docs/images/gtd/time-approved.png) | `cb6e8c81` |

The Goals image is the synthetic rendering of the approved view. Behaviour, metrics and limits are in
[design](docs/design.md), [Goals](docs/goals.md), [GTD](docs/gtd.md) and [verification](docs/verification.md).

New captures and side-by-side comparisons stay out of Git: keep them in `design-qa-artifacts/` (ignored) or in
Playwright's per-test output, and commit only an approved design that docs link to.
