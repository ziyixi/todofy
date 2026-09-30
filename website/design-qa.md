# Design QA

## Evidence

- Visual source: `doc/assets/homepage-concept-v6.png` (1586×992).
- Desktop implementation: `design-qa-artifacts/home-1366x768-viewport.png` (1366×768 requested browser viewport; 1351×760 captured content bitmap).
- Side-by-side comparison: `design-qa-artifacts/home-comparison.png` (2702×802).
- Mobile focused evidence: `design-qa-artifacts/home-375x812-top.png` and `design-qa-artifacts/home-375x812-bottom.png` (375×812 requested browser viewport; 360×780 captured content bitmaps).
- Reflow evidence: `design-qa-artifacts/home-683-reflow.png` (683px requested viewport, equivalent to the 1366px layout at 200% reflow; 668×883 captured content bitmap).
- States inspected in the browser: home empty-blog state, Blog empty state, Publications with two complete citations, 404, keyboard skip-link focus, and mobile top/bottom scroll positions.

## Comparison

The implementation preserves the approved v6 hierarchy and character: compact 800px academic column, small name, left-aligned text navigation with a short current-page underline, About before Blog and publications, square unframed portrait, Source Sans/Source Serif pairing, muted off-white palette, and no cards, section rules, shadows, gradients, side labels, or decorative cover art.

Intentional, source-backed differences:

- Only verified GitHub and LinkedIn links are rendered. Email, Scholar, and CV stay hidden until real destinations/files are supplied.
- The implementation uses the plan's 800px column, 120px portrait, and 16px body starting values, so density is slightly more compact than the illustrative concept image.
- The supplied original portrait is used rather than the concept image's generated likeness.

## Responsive and accessibility checks

- Desktop: no horizontal overflow; content shell computed at 800px; portrait computed at 120px.
- Mobile: navigation wraps naturally, portrait precedes biography text, the page remains a single readable column, and top/bottom captures show complete content without clipping.
- 200% reflow proxy: no horizontal document overflow at 683px.
- Keyboard: first Tab focuses “Skip to content” with a visible 3px outline; activating it targets `#main-content`.
- Semantics: one page H1 followed by ordered H2/H3 content, `aria-current` on navigation, article language metadata, and meaningful portrait alt text.
- Browser console: no warnings or errors on the inspected routes.

## Iteration history

1. Compared the first implementation with v6 and tightened the shell, typography, section rhythm, link color, portrait sizing, and mobile ordering.
2. Detected that the in-app browser's full-page capture mode rescaled the page; rejected those captures as comparison evidence and repeated QA with normal viewport screenshots.
3. Verified the final desktop comparison, mobile top/bottom states, reflow state, active navigation states, 404 response, and keyboard focus behavior.

## Final result

passed
