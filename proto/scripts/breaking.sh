#!/bin/sh
# Breaking-change gate of proto/ (README.md, Rules): `buf breaking` (FILE) and the wire profile's own rules
# (tools/profile_breaking.py: REQUIRED and presence) of the working tree against proto/ at BASE.
#
#   scripts/breaking.sh BASE      (npm run breaking -- BASE; the pinned buf from npm ci in proto/)
#
# BASE is a commit in this clone (CI: actions/checkout with fetch-depth: 0). The "Proto checks" job passes
# the Changes job's diff base: on a push to main the commit of the last successful main run, on a branch
# the merge base with origin/main. Never origin/main itself: on a push to main it is HEAD, and comparing
# a commit with itself passes everything. An empty BASE (Changes found no usable base and checks
# everything) falls back to HEAD~1 and says so; a BASE that predates proto/ has nothing to break.
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -ne 1 ]; then
  echo "usage: $0 BASE (a commit; empty means HEAD~1)" >&2
  exit 2
fi
BUF=node_modules/.bin/buf
REPO=$(git rev-parse --show-toplevel)
base=$1
if [ -z "$base" ]; then
  base=HEAD~1
  echo "note: no base commit was given (no usable CI diff base); comparing with HEAD~1 only"
fi
if ! BASE=$(git -C "$REPO" rev-parse --verify --quiet "$base^{commit}"); then
  echo "error: base $base is not a commit in this clone (a shallow checkout? use fetch-depth: 0)" >&2
  exit 1
fi
if [ "$BASE" = "$(git -C "$REPO" rev-parse HEAD)" ]; then
  echo "note: the base is HEAD, so only uncommitted changes are compared"
fi
if ! git -C "$REPO" cat-file -e "$BASE:proto/buf.yaml" 2>/dev/null; then
  echo "skipped: $BASE predates proto/, so no existing contract can break"
  exit 0
fi
WORK=$(mktemp -d "${TMPDIR:-/tmp}/proto-breaking.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
git -C "$REPO" archive "$BASE" proto | tar -x -C "$WORK"
echo "== buf breaking (FILE) against $BASE"
"$BUF" breaking --against "$WORK/proto"
echo "== wire profile rules against $BASE"
"$BUF" build "$WORK/proto" --exclude-source-info -o "$WORK/base.json#format=json"
"$BUF" build --exclude-source-info -o "$WORK/head.json#format=json"
python3 tools/profile_breaking.py "$WORK/base.json" "$WORK/head.json"
echo "proto/: no breaking change against $BASE"
