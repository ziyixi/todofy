# Home verification record

These records describe the source and environment at their dates. They do not establish the current deployment,
current credentials or external business success. Current release work and acceptance belong to root
[HANDOFF](../../HANDOFF.md); current runtime behavior is [design.md](design.md).

## Current acceptance

`bazel test //dashboard:check` is the application check closure; `bazel build //dashboard` produces its release
archive. Synthetic unit/UI/workerd cases cover wire output, Access and mutation gates, service failures, quota
hysteresis, canary phases, digest request identity, reminder controls, drift and read/CPU/body budgets.
A branch build remains separate from same-revision main publication, live owner interaction and reconcile.

## Dated evidence

| Date | Scope and result | Limit |
| --- | --- | --- |
| 2026-09-29 | Initial clean-clone Worker, HomeState and UI checks exercised synthetic Ops/GraphQL inputs, guard decisions, canary and digest behavior | Local prototype checks; original two-app layout and deployment procedure are superseded |
| 2026-09-30 | Four-view UI and registry were exercised against the real Worker in local workerd, with fake services/providers, desktop and 390px layouts, light and dark | Synthetic local acceptance; historical bundle/CPU figures are not current budgets |
| 2026-10-02 | `dashboard.ui.v1` migration checked strict wire conformity, IDL-derived bounds, ETag/304 behavior and the old client's handling of every retained 410 route | Loopback/synthetic checks, without production account calls; compatibility dates remain in the root table |
| 2026-10-25 | Source `0a1b647f` passed branch checks, same-source main publication and matching Personal cloud reconcile. Metadata-only comparison and real-browser refresh completed the fourteen-Worker configuration check with zero configuration differences | This dated configuration/browser result does not verify later revisions or business operations |

The October 25 UI checks distinguished configuration findings from account-operation history, retained prior
completed evidence when a newer read failed, and kept a multi-tick drift refresh separate from usage refresh.
No reminder was dismissed or live resource modified to force that result.

The complete original per-step measurements and receipts remain in the
[fixed pre-cleanup record](https://github.com/ziyixi/todofy/blob/288e5ef7/dashboard/docs/verification.md).
That historical snapshot includes retired jobs, routes, signed-CSRF setup and initial pending checklists; none is a
current execution instruction. Frozen contract/golden files remain in the repository and continue to be tested.
