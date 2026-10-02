# workerd-cpu: calibrated CPU bounds for the workerd tests

The shared part of the apps' CPU tests: Lab's, FlowDay's, the links app's, the dashboard's and the watch app's
`worker/test/runtime/cpu.test.ts`, and Mail Hero's `cloudflare/test/cpu/native-ops-cpu.test.mjs`. Test tooling
only: tests import [`workerd-cpu.mts`](workerd-cpu.mts) by relative path, no bundle carries it, and a change here
re-checks every app and deploys none (`.github/scripts/ci_changes.py`). Its own tests need no workerd:

```sh
node --test tools/workerd-cpu/test/*.test.mts
```

## How a CPU test measures

1. **Isolates.** `measureInIsolates(COLD_ISOLATES, start, session)` starts a fresh isolate (a new Miniflare with the
   app's data, `inspectorPort: 0`), runs the test's session in it, calibrates it, and disposes of it; three times,
   one after another.
2. **Session.** `meter.measure(label, run, times)` profiles each run of a request: the first run is that code path's
   first run in the isolate, the others give the warm median and best. The isolate's very first request is a
   measurement of one run.
3. **Calibration.** After the session (so every first run in it was a first run), a fixed workload runs in the
   isolate; its warm median wall time over the reference machine's (an Apple M1 Max, 4.8 ms) is the speed.
4. **Reference milliseconds.** Each isolate's numbers are divided by its own `scaleFor(speed)` (never below 1), and
   the bounds hold each number's median across the isolates. A test's bounds are reference milliseconds.

Two guards keep a busy machine from hiding a regression. An isolate whose calibration wall time is more than
`MAX_WALL_OVER_CPU` (1.2) times its profile CPU measured a busy moment, not the machine, and is replaced by another
fresh isolate (at most three more). A median speed above `MAX_SPEED` (5) fails the test. Every inspector call fails
after 30 s with the step it was in, instead of hanging until the runner's timeout; `CPU_TEST_TIMEOUT_MS` (300 s), the
tests' own timeout, leaves room for replaced isolates on a busy machine.

## Why the median of three isolates (2026-10-01)

The cold assertions were the flaky ones. On GitHub runners Lab's first API request, a single isolate's single run,
read 4.2-5.3 reference ms in ten runs and 5.7-7.2 in the five after ops-v1 moved onto `proto/`. One of those was
7.18 against a bound of 7 (speed 1.69; its rerun passed). The warm medians of the same runs stayed close to the
reference machine's. Two things make a cold number noisy, and the data separates them.

- **One sample per isolate.** Mail Hero's test already measured three isolates. On runners its isolates read 4.8 to
  7.3 ms within a run, for example 5.1, 7.3 and 6.9; on the idle reference machine they read 3.5-7.7 (35 isolates).
  The median of three is never decided by one isolate's outlier, high or low. Each isolate is scaled by its own
  calibration, which runs within seconds of its cold run.
- **Machines differ more on cold runs than on warm ones.** Runners read cold runs higher than the reference machine,
  even after scaling by the warm calibration: Lab about 1.3 times (median 6.2 against 4.8), the dashboard's first
  tick 1.2 times (11.6 against 9.6), FlowDay's first sync 1.15 times, Mail Hero 1.0-1.2 times (higher on the faster
  runners), and the links app's first API request 0.95 times. A median does not remove this. Each bound keeps the
  headroom its app needs above the runners, and still fails a 5 ms regression on the reference machine.

| Measured | Reference machine, idle | Runners (single isolates) | Bound |
| --- | --- | --- | --- |
| Lab, first API request | 4.0-5.2 | 5.7-7.2 | 8.5 (was 7) |
| Lab, other first runs | at most 3.4 | at most 3.6 | 7 |
| Links, first request / first API request | 1.2-1.7 / 4.2-4.5 | 1.0-1.7 / 3.2-4.3 | 3 / 9 |
| Dashboard, first tick | 8.4-10.3 | 11.1-12.4 | 16 |
| Mail Hero, first `status()` | 5.8-6.9 | 5.0-7.1 (medians of 3) | 9 (was 8) |
| FlowDay, first sync chunk | 8.5-9.3 | 8.8-11.0 | 15 |
| Watch, the fetch handler's very first request | 2.0-2.2 | 2.8 (one run) | 6 |

All values are reference ms. The reference machine's are medians of three isolates over eight runs of each runtime
suite (single isolates spread wider: the dashboard's 6.3-11.8). The runner data comes from 15 Lab, 11 links, 5
dashboard, 5 Mail Hero and 15 FlowDay check jobs on 2026-10-01.

**Regression proof.** A deterministic loop of about 5 ms of CPU (5.0-5.4 ms in the profile) was added to the first
request of the isolate: Lab's fetch handler, Mail Hero's `Ops.status()`. With it, every one of six runs per app
failed on the reference machine. Lab read medians of 9.8-10.1 against 8.5. Mail Hero read 10.6-11.2 against 9.
Without the replacement of disturbed isolates, one of five Lab runs passed: one isolate's calibration hit a busy
moment (12.6 ms wall for 5.6 ms of CPU, so a speed of 2.62), and another isolate lost samples.

**Pass rates.** These runs were on the reference machine while other work loaded it (load average 4-14). Every touched
runtime suite passed 8 of 8 runs: Lab, the links app, the dashboard, Mail Hero's `test:cpu`, FlowDay and the watch
app. With nine of its ten cores also busy (`yes`, load average 17-42), each passed 2 of 2. On such a machine most
calibrations are disturbed and the profiles lose samples, so the numbers read low. The test stays as lenient there
as it always was; `MAX_SPEED` is its limit.

**Calibration wall time against profile CPU.** Runners measured at most 1.07 (61 calibrations). The idle reference
machine measured at most 1.14 (71). With nine of its ten cores busy (`yes`), the median was 1.37 and 42 of 48 were
above 1.15. A threshold of 1.2 never replaces an isolate on a runner.

**Rejected alternatives.** These were measured on the reference machine: per-isolate coefficients of variation, idle
and with nine cores busy.

| Cold number divided by | Idle | Busy |
| --- | --- | --- |
| warm calibration (kept) | 0.04-0.12 | 0.32-0.48 |
| a fresh-code calibration (new source compiled each run, so every run is cold) | 0.04-0.12 | 0.30-0.49 |
| the calibration workload's own first run | 0.09-0.18 | 0.37-0.59 |
| the same request's warm median (a ratio bound) | 0.05-0.14 | 0.31-0.50 |

- **Fresh-code calibration.** It tracked cold runs no better than the warm calibration, and it adds a second
  reference to maintain. Whether it would track the runners' cold/warm difference cannot be measured from here, and
  the difference varies by app (0.95-1.3), so one factor could not remove it.
- **The workload's own first run.** This is a single sample too.
- **A ratio to the warm median.** It reads a number with no unit against Free's 10 ms. Its denominator is a warm
  median of about 1 ms in 0.4 ms steps. It does not see the runners' cold offset either: the dashboard's warm tick
  matches the reference machine while its first tick does not.

**Two flakes that were not CPU at all.**

- Each test picked a random inspector port in a fixed range. Mail Hero's and the links app's ranges overlapped, and
  10080 is on the Fetch standard's blocked-port list: 1 of 60 local Mail Hero runs failed with `fetch failed: bad
  port`. Port 0 lets the OS choose.
- One run of 12 hung until its 300 s timeout after an isolate's restart. The meter had no timeout and ignored a
  closed socket, so a stuck or refused inspector connection waited forever.

**Cost.** These are per-test durations on the reference machine, under the background load of other work, before
and after the change:

- Lab: 2.3 → 6.7-8.5 s.
- The links app: 1.9 → 4.6-5.1 s.
- The dashboard: 0.8 → 1.6 s, or 3.3 s with a replaced isolate.
- Mail Hero: 2.6 → 3.5-4.9 s. It already started three isolates.
- FlowDay: 21 → 22-29 s. It measures only the sync's first chunk in every isolate but the third.
- The watch app: 26-29 s. The two extra isolates measure one request each.

The whole runtime suites take 11-52 s. With nine of ten cores busy, the CPU tests took 6-64 s.

## Changing it

- **The calibration workload or a workerd update.** Measure `CALIBRATION_REFERENCE_MS` again: the warm median wall
  over several runs on the reference machine. The unit test pins `CALIBRATION_CHARS`.
- **A bound.** Keep it above the runners' numbers (the CI log prints every isolate's number and the medians). Check
  that a 5 ms injected regression still fails on the reference machine.
