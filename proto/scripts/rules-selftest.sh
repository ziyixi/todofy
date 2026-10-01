#!/bin/sh
# Proves that the lint and breaking rules catch what they are meant to (README.md, Rules): each case
# copies the module to a temporary directory, applies one edit to one .proto file (task_intent.proto unless
# the case names another) and expects a verdict. "breaking" is what scripts/breaking.sh runs against its
# base: buf breaking (FILE) plus tools/profile_breaking.py (REQUIRED and presence, which the wire profile
# treats as wire, and the HTTP APIs' bindings, signatures, resources, OUTPUT_ONLY inputs and formats). Exit
# status 0 only when every verdict is the expected one.
set -eu
cd "$(dirname "$0")/.."
BUF=$(cd node_modules/.bin && pwd)/buf
WORK=$(mktemp -d "${TMPDIR:-/tmp}/proto-selftest.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
INTENT=todofy/taskintent/v1/task_intent.proto
LAB=lab/ui/v1/lab_ui_service.proto
failures=0
"$BUF" build --exclude-source-info -o "$WORK/base.json#format=json"

# case <name> <lint|breaking> <pass|fail> <perl substitution applied to the proto> [<file>]
case_() {
  name=$1 kind=$2 want=$3 edit=$4 FILE=${5:-$INTENT}
  rm -rf "$WORK/m" && mkdir -p "$WORK/m" && cp buf.yaml buf.lock "$WORK/m/"
  # Every package directory of the module (buf.yaml `excludes` are tooling, not module files).
  for dir in */; do
    case ${dir%/} in node_modules | python | scripts | test | testdata | tools | ts) ;; *) cp -R "${dir%/}" "$WORK/m/" ;; esac
  done
  perl -0pi -e "$edit" "$WORK/m/$FILE"
  if cmp -s "$FILE" "$WORK/m/$FILE"; then echo "SETUP ERROR  $name: the edit changed nothing"; failures=$((failures + 1)); return; fi
  if [ "$kind" = lint ]; then
    (cd "$WORK/m" && "$BUF" lint --error-format json >"$WORK/out" 2>&1) && got=pass || got=fail
  else
    got=pass
    (cd "$WORK/m" && "$BUF" breaking --error-format json --against "$OLDPWD" >"$WORK/out" 2>&1) || got=fail
    (cd "$WORK/m" && "$BUF" build --exclude-source-info -o "$WORK/head.json#format=json") >>"$WORK/out" 2>&1 || got=fail
    python3 tools/profile_breaking.py "$WORK/base.json" "$WORK/head.json" --config buf.yaml >>"$WORK/out" 2>&1 || got=fail
  fi
  if [ "$got" = "$want" ]; then
    rules=$( (grep -o '"type":"[A-Z_]*"' "$WORK/out" | cut -d'"' -f4; grep -o '^PROFILE_[A-Z_]*' "$WORK/out") | sort -u | tr '\n' ' ')
    printf 'ok    %-9s %-4s %s %s\n' "$kind" "$got" "$name" "$rules"
  else
    printf 'FAIL  %-9s got %s, want %s: %s\n' "$kind" "$got" "$want" "$name"; sed 's/^/      /' "$WORK/out"
    failures=$((failures + 1))
  fi
}

case_ "renumber a field (tasks_created 7 -> 11)" breaking fail 's/int32 tasks_created = 7/int32 tasks_created = 11/'
case_ "remove a field (TaskIntentItem.url)" breaking fail 's/  \/\/ https, host on[^\n]*\n  optional string url = 2;\n//'
case_ "remove a field but reserve its number and name" breaking fail 's/  \/\/ https, host on[^\n]*\n  optional string url = 2;\n/  reserved 2;\n  reserved "url";\n/'
case_ "rename a field (TaskIntentRef.intent_id -> idempotency_key)" breaking fail 's/(The intent to look up.\n  string) intent_id/$1 idempotency_key/'
case_ "rename an enum value (DAILY_LIMIT -> DAILY_QUOTA)" breaking fail 's/ERROR_CODE_DAILY_LIMIT = 11/ERROR_CODE_DAILY_QUOTA = 11/'
case_ "change a field type (tasks_total int32 -> int64)" breaking fail 's/int32 tasks_total = 6/int64 tasks_total = 6/'
case_ "add an enum value (ERROR_CODE_QUOTA_EXHAUSTED = 14)" breaking pass 's/(  ERROR_CODE_SOURCE_NOT_ALLOWED = 13;\n)/$1  \/\/ The Todoist quota is exhausted.\n  ERROR_CODE_QUOTA_EXHAUSTED = 14;\n/'
case_ "add an optional field (TaskIntentResult.hint_code = 11)" breaking pass 's/(updated_at = 10 \[\(google.api.field_behavior\) = REQUIRED\];\n)/$1  \/\/ An optional hint code.\n  optional string hint_code = 11;\n/'
# The wire profile's own rules (tools/profile_breaking.py): buf alone passes the first four.
case_ "drop REQUIRED from retry_after_seconds (null would be omitted)" breaking fail 's/(optional int32 retry_after_seconds = 9) \[\(google.api.field_behavior\) = REQUIRED\]/$1/'
case_ "drop REQUIRED from error_code" breaking fail 's/(ErrorCode error_code = 8) \[\(google.api.field_behavior\) = REQUIRED\]/$1/'
case_ "add REQUIRED to TaskIntentItem.url (older payloads omit it)" breaking fail 's/optional string url = 2;/optional string url = 2 [(google.api.field_behavior) = REQUIRED];/'
case_ "add a REQUIRED field to an existing message" breaking fail 's/(updated_at = 10 \[\(google.api.field_behavior\) = REQUIRED\];\n)/$1  \/\/ A required hint code.\n  string hint_code = 11 [(google.api.field_behavior) = REQUIRED];\n/'
case_ "drop optional from retry_after_seconds (0 instead of null)" breaking fail 's/optional int32 retry_after_seconds = 9/int32 retry_after_seconds = 9/'
# The HTTP APIs (tools/profile_breaking.py): buf alone passes every one of these, though old clients break.
case_ "move GetDeck to another path (/api/v1 -> /api/v2)" breaking fail 's{get: "/api/v1/\{name=decks/\*\}"}{get: "/api/v2/{name=decks/*}"}' "$LAB"
case_ "rename a custom verb (:decide -> :swipe)" breaking fail 's/\}:decide"/}:swipe"/' "$LAB"
case_ "change a verb (UpdateSettings PATCH -> PUT)" breaking fail 's/patch: "\/api\/v1\/\{settings.name=settings\}"/put: "\/api\/v1\/{settings.name=settings}"/' "$LAB"
case_ "change a body (UpdateSettings settings -> *)" breaking fail 's/body: "settings"/body: "*"/' "$LAB"
case_ "drop the HTTP binding of an rpc (GetPipelineStatus)" breaking fail 's/    option \(google.api.http\) = \{get: "\/api\/v1\/\{name=pipelineStatus\}"\};\n//' "$LAB"
case_ "add an additional binding (GetDeck at /api/v1/days/*)" breaking pass 's{get: "/api/v1/\{name=decks/\*\}"\}}{\n      get: "/api/v1/{name=decks/*}"\n      additional_bindings: {get: "/api/v1/days/{name=decks/*}"}\n    \}}' "$LAB"
case_ "move the old path to an additional binding (GetDeck /api/v2, /api/v1 kept)" breaking pass 's{get: "/api/v1/\{name=decks/\*\}"\}}{\n      get: "/api/v2/{name=decks/*}"\n      additional_bindings: {get: "/api/v1/{name=decks/*}"}\n    \}}' "$LAB"
case_ "change a method_signature (GetDeck name -> name,etag)" breaking fail 's/(rpc GetDeck\(GetDeckRequest\) returns \(Deck\) \{\n[^\n]*\n    option \(google.api.method_signature\) = )"name"/$1"name,etag"/' "$LAB"
case_ "change a resource pattern (decks/{deck} -> days/{deck})" breaking fail 's/pattern: "decks\/\{deck\}"/pattern: "days\/{deck}"/' lab/ui/v1/deck.proto
case_ "change a resource type (Deck -> DailyDeck)" breaking fail 's/type: "lab.ziyixi.science\/Deck"/type: "lab.ziyixi.science\/DailyDeck"/' lab/ui/v1/deck.proto
case_ "make an input field OUTPUT_ONLY (SnoozeDeckRequest.request_id)" breaking fail 's/(string request_id = 2 \[\n    \(google.api.field_info\).format = UUID4,\n    \(google.api.field_behavior\) = )OPTIONAL(\n  \];\n\}\n\n\/\/ Output of SnoozeDeck)/$1OUTPUT_ONLY$2/' "$LAB"
case_ "add a format to an existing field (ExcludePaperRequest.paper_id UUID4)" breaking fail 's/string paper_id = 2 \[\(google.api.field_behavior\) = REQUIRED\];/string paper_id = 2 [\n    (google.api.field_info).format = UUID4,\n    (google.api.field_behavior) = REQUIRED\n  ];/' "$LAB"
case_ "change a binding of the test fixtures (prototest is ignored, as by buf)" breaking pass 's/\{get: "\/v1\/\{parent=shelves\/\*\}\/books"\}/{get: "\/v2\/{parent=shelves\/*}\/books"}/' prototest/v1/prototest.proto
case_ "zero value without _UNSPECIFIED (MODE_UNSPECIFIED -> MODE_NONE)" lint fail 's/MODE_UNSPECIFIED = 0/MODE_NONE = 0/'
case_ "enum value without its prefix (SOURCE_LAB -> LAB)" lint fail 's/SOURCE_LAB = 1/LAB = 1/'
case_ "lowerCamelCase field (intent_id -> intentId)" lint fail 's/string intent_id = 3;/string intentId = 3;/; s/string intent_id = 3 /string intentId = 3 /'
case_ "undocumented field" lint fail 's/  \/\/ Tasks created so far.\n//'

echo "$failures unexpected verdict(s)"
[ "$failures" -eq 0 ]
