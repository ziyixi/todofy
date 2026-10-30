# Tasks browser tests

The browser toolchains use the official Playwright 1.63.0 headless shell: Chrome 153.0.8010.12,
revision 1243, with separate SHA-256 pins for macOS arm64 and Linux amd64. The URLs were checked with
the locked Playwright CLI's `install chromium-headless-shell --dry-run`, including its Linux platform
selection. No browser install runs as part of a test.

The bootstrap sets `PLAYWRIGHT_BROWSERS_PATH` to the declared archive before importing Playwright.
This also covers specs that call `chromium.launchPersistentContext` directly. A Playwright version
change requires updating the corresponding archive pins. Each browser profile is temporary.

Tasks' original `playwright.config.ts` supplies the tests' settings. The Bazel adapter selects the
registered Node executable for its synthetic backend and puts test artifacts in Bazel's output
directory. Playwright's file discovery skips symlinks, so the adapter canonicalizes the original
test directory and each declared spec into the same output tree. Native Node and esbuild use their
normal filesystem canonicalization; Bazel's operating-system sandbox remains active.
The frontend comes from `//tasks/web:bundle`; the backend is the original ephemeral D1
harness with declared migrations and generated proto dependencies.

Each spec has its own `browser_<spec>_test` target. They have `browser` and `exclusive` tags because
the original server and fixtures share local ports. The CI browser group also sets
`--local_test_jobs=1`. Run the suite with:

```sh
bazel test //tasks/web:browser_tests
```
