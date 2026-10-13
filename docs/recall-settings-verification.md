# Recall settings verification

Implementation: `1ab7cfc95a2ed272228d696ab0edd85dc29f0c9b`, October 12, 2026 (America/Los_Angeles).

## Checks and release

- Web typecheck, lint, build and 144 tests pass; JavaScript is 62.9 KiB gzip within the unchanged 64 KiB budget.
- Worker typecheck, lint and 158 unit tests pass. Related real-workerd connection/token/CPU/scale checks pass,
  including indexed presence checks over 220,000 visits and more than 20,000 snapshots. The existing upload,
  archive and retention smoke passes. Proto lint, API lint and breaking checks pass.
- [Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38334672139) passes at the implementation SHA.
  [Same-SHA main release](https://github.com/ziyixi/todofy/actions/runs/38335237087) also passes. Only Recall deploys;
  other application/image/VPS releases and extension publication are skipped.
- Deployment `7028272346` records verified Worker `1bcd9109-a612-4520-b0f0-35dc9d7a8fb4`, success at
  `2026-10-13T02:07:05Z`. The live Settings footer shows `1ab7cfc`.

## UI evidence

The local UI uses the existing real-workerd harness with synthetic data. Eight connections appear as two display
groups with older same-name installations folded. At a 390px viewport, document scroll width is also 390px;
there is no horizontal overflow. Renaming an existing token saves through the real owner API. Synthetic UI/runtime
checks preserve the credential digest, creation time, previous-token grace and existing authentication; Worker-secret-only
credentials are directly renamable without generating a new token. Historical device IDs remain selectable.

Scoped read-only production verification checks only the connection card, credential controls and build footer:

- Eight connections now appear as two groups; six old same-name phone installations are folded by default.
- Exactly six empty connections offer removal. Recorded connections have no removal button.
- Credential controls expose rename for the existing upload credentials; no one-time secret is displayed.

No production credential was renamed or rotated, and no production connection was deleted. The local browser's
native confirmation blocked the automated empty-delete UI check; the owner was away from the computer. Backend
runtime checks separately prove empty removal, refusal for visits/snapshots/pending uploads and safe request replay.
The empty production test connections are identified and folded, with their guarded removal controls available.
This record does not claim that the production deletion was executed. Private IDs, browsing content and credentials
are omitted. The synthetic preview process was stopped; a blocked temporary local browser tab may need closing.

The browser extensions and their installed files were untouched. The phone's recurring `page_probe_invalid_result`,
screenshot capture and unattended upload acceptance remain separate open work; this release changes settings only.

## October 13 inline removal follow-up

Implementation `566858edc1d4f65fdd9f1a6572b573660cee9806` replaces the blocking native empty-connection prompt with
an inline confirmation. The first click shows the explanation, Confirm removal and Cancel; only the second click
requests deletion. Cancellation restores the original control. A server refusal leaves the controls usable and
does not start another UI request automatically. The existing mutation helper and backend guard are unchanged.

Focused synthetic checks cover confirmation, cancellation and a pending-upload refusal before a later explicit
retry. Historical links remain, and only connections explicitly reporting no records and zero queued items offer
removal. The server independently checks visits, snapshots and the last reported queue before deleting only the
connection row. No token or historical record is removed.

[Full branch CI](https://github.com/ziyixi/todofy/actions/runs/38342293896) and
[same-SHA main release](https://github.com/ziyixi/todofy/actions/runs/38343212917) pass. Only Recall Worker and
extension publication ran; other app/image/VPS jobs were skipped. Deployment `7029536483` verifies Worker
`3f20c580-27f1-47e8-8a31-3cd357ec439b`, success at `2026-10-13T03:47:07Z`. The live Settings footer shows `566858e`.

With the owner's existing authorization, six empty phone test connections were removed individually using the
inline confirmation, waiting for the displayed count to update after each. Their extension versions were
`2026.1012.1736`, `2026.1012.812`, `2026.1012.611`, `2026.1012.429`, `2026.1012.403` and `2026.1012.322`.
The live card now shows two groups and two connections. The current phone (`2026.1013.45`) and desktop
(`2026.1012.429`) remain and offer no removal button. No token was changed, and historical records were not deleted.
Private connection IDs and credentials are omitted. This verifies the guarded production cleanup, not the new
phone extension's capture, screenshots or automatic uploads. The earlier dated settings evidence remains unchanged.
