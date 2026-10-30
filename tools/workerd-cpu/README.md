# workerd CPU checks

Worker CPU tests import [`workerd-cpu.mts`](workerd-cpu.mts) as test tooling. It is absent from application bundles;
Bazel selects the CPU checks that declare it. Its fake-inspector unit checks run with:

```sh
bazel test //tools/workerd-cpu:check
```

App CPU tests use their own declared `cpu` targets, run exclusively without cached test results. Their bounds remain
in the original test files. The meter estimates workerd isolate CPU through DevTools sampling; it is not Cloudflare's
production CPU meter. Storage and outbound I/O outside the isolate do not count as isolate CPU.

## Measurement

A session runs in three fresh isolates, one after another, with an OS-assigned inspector port. Each request records
its first run and subsequent warm runs. After all measured paths, a deterministic workload calibrates the same
isolate against the 4.8 ms reference warm median from an Apple M1 Max. Calibrating afterwards preserves real first-run
behavior. A result is divided by its isolate's speed factor, never below one; bounds use the median of three scaled
isolates, in reference milliseconds.

Sampling uses 100 µs intervals and caps one sample at four intervals, so a descheduled sampling thread cannot count
a long gap as application CPU. A calibration with wall/profile CPU ratio above 1.2 is disturbed and must be replaced.
Inspector timeouts also permit a replacement, within the same three-extra-isolate limit. Other errors fail
immediately. Every inspector call times out after 30 seconds; fewer than three completed isolates fails with named
timeouts. Median speed above five fails instead of scaling away a regression. The overall test allowance is
300 seconds.

## Changing the workload or bounds

Changing the calibration workload or workerd version requires measuring its reference again; the unit test pins the
calibration output size. Keep each app's bounds above genuine runner variation and verify an injected 5 ms CPU
regression still fails. Three isolates reduce cold-run outliers but do not remove every machine-specific cold/warm
difference, so those assertions keep their measured headroom.

The original calibration evaluation on 2026-10-01 showed a deterministic 5.0–5.4 ms injected loop failing all six
reference runs (10.6–11.2 ms against a 9 ms bound). Disturbed-calibration replacement prevented an overloaded isolate
from dividing that regression away. Historical per-run timings and rejected calibration experiments remain in Git
history; current changes require fresh measurements rather than treating those old timings as acceptance.
