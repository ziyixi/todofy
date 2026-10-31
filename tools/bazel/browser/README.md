# Browser checks

The toolchains provide official Playwright 1.63.0 browser archives with SHA-256 pins for macOS arm64 and Linux amd64:
Chromium headless shell revision 1243 (Chrome 153.0.8010.12), and WebKit revision 2359 (26.6). Repository definitions
record the platform URLs and hashes. A Playwright update must update and validate the matching browser inputs.
Tests select their own declared registry before importing Playwright; no test downloads a browser or uses an owner's
normal browser cache/profile.

```sh
bazel test //tasks/web:browser_tests
bazel test //website/tests/e2e:tests
bazel test //recall/extension:browser_tests
```

Tasks keeps its original spec/config and ephemeral D1 backend. Website checks its explicit empty/fixture exports and
route contracts. Recall runs the built options/background/probe code with real WebKit DOM, IndexedDB, image encoding
and gzip behind a synthetic extension API bridge. The latter does not establish Orion iOS API or suspension behavior.

Adapters canonicalize declared specs because Playwright discovery skips symlinks, use the registered Node/tool inputs
and put traces/reports in test outputs. Browser profiles are temporary. Shared-port Tasks cases are exclusive and CI
runs its browser group with `--local_test_jobs=1`.

Ephemeral Linux CI prepares OS libraries with `bazel run //tools/bazel/browser:install_dependencies` using that same
locked Playwright CLI. The website release needs only `:install_chromium_dependencies`. These are explicit host
preparation operators, separate from the pinned browser archives and ordinary checks. They are not installation
commands for the owner's Chrome or phone.
