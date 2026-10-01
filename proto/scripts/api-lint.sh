#!/bin/sh
# Google's api-linter (https://linter.aip.dev) on every file of the buf module except the runtimes' test
# fixtures (prototest/: deliberately varied bindings). Run from proto/: npm run api-lint.
#
# One version: the linter is a Go tool of the module tools/api-linter (go.mod pins api-linter and the Go
# toolchain, go.sum the checksum of every dependency; nothing else in the repository installs it), built
# into .tools/ (ignored). The input is buf's image of the module with its imports and source info (the
# comments carry the `(-- api-linter: ... --)` exceptions), so the linter reads exactly what buf compiled,
# with the googleapis version buf.lock pins.
set -eu

cd "$(dirname "$0")/.."
if ! command -v go >/dev/null 2>&1; then
  echo "api-lint: needs Go (https://go.dev/dl/); tools/api-linter/go.mod names the toolchain it switches to" >&2
  exit 2
fi
mkdir -p .tools
# -mod=readonly: go.mod and go.sum are the pins; a build that would need to change them fails.
go -C tools/api-linter build -mod=readonly -o ../../.tools/api-linter github.com/googleapis/api-linter/v2/cmd/api-linter

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
node_modules/.bin/buf build -o "$work/image.binpb"
# Every module file but the fixtures, in a stable order.
files=$(find . -name '*.proto' -not -path './node_modules/*' -not -path './prototest/*' -not -path './python/*' \
  -not -path './scripts/*' -not -path './test/*' -not -path './testdata/*' -not -path './tools/*' -not -path './ts/*' \
  -not -path './.*' | sed 's|^\./||' | LC_ALL=C sort)
# shellcheck disable=SC2086 # one argument per file; module paths have no spaces (buf lint enforces it)
if .tools/api-linter --descriptor-set-in "$work/image.binpb" --output-format yaml --output-path "$work/report.yaml" \
  --set-exit-status $files; then
  echo "api-linter $(.tools/api-linter --version | sed 's/^api-linter //'): no problems in $(echo "$files" | wc -l | tr -d ' ') files"
else
  # The report without the files that have no problem.
  sed '/^- file_path:/{N;/problems: \[\]/d;}' "$work/report.yaml" >&2
  exit 1
fi
