#!/bin/sh
# Proves that the lint and breaking rules catch what they are meant to (README.md, Rules): each case
# copies the module to a temporary directory, applies one edit to one .proto file (task_intent.proto unless
# the case names another) and expects a verdict. "breaking" is what scripts/breaking.sh runs against its
# base: buf breaking (FILE) plus tools/profile_breaking.py (REQUIRED and presence, which the wire profile
# treats as wire, the value rules and closed enums of common/wire/v1, and the HTTP APIs' bindings, signatures,
# resources, OUTPUT_ONLY inputs and formats). Exit
# status 0 only when every verdict is the expected one.
set -eu
cd "$(dirname "$0")/.."
BUF=$(cd node_modules/.bin && pwd)/buf
WORK=$(mktemp -d "${TMPDIR:-/tmp}/proto-selftest.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
INTENT=todofy/taskintent/v1/task_intent.proto
LAB=lab/ui/v1/lab_ui_service.proto
OPS=ops/v1/ops.proto
REPORT=todofy/report/v1/report.proto
MAIL=mailhero/webhook/v1/mail_received.proto
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
# The wire options of common/wire/v1 (tools/profile_breaking.py): buf passes both, though the bytes or the calls change.
case_ "drop keep_order from OpsStatus.counters (every producer's counters would be reordered)" breaking fail 's/(key_format: "Code"\n      max_items: 32\n)      keep_order: true\n/$1/' "$OPS"
case_ "take canaryDelivery's request as one object (drop positional)" breaking fail 's/(rpc CanaryDelivery\(CanaryDeliveryRequest\) returns \(.ops.v1.CanaryDelivery\) \{\n)    option \(common.wire.v1.method\).positional = true;\n  \}/$1  }/' "$OPS"
# The value rules and closed enums of common/wire/v1 (tools/profile_breaking.py): both codecs check them on every read.
# An output's rule may not change either way (older and newer readers check older and newer writers):
case_ "widen Code to 64 characters (older dashboards refuse a newer app's longer code)" breaking fail 's/\[a-z\]\[a-z0-9_\]\{0,47\}/[a-z][a-z0-9_]{0,63}/' "$OPS"
case_ "narrow Code to 30 characters (a newer dashboard refuses an older app's code)" breaking fail 's/\[a-z\]\[a-z0-9_\]\{0,47\}/[a-z][a-z0-9_]{0,29}/' "$OPS"
case_ "lower OpsStatus.counters max_items 32 -> 16" breaking fail 's/max_items: 32/max_items: 16/' "$OPS"
case_ "change OpsStatus.version's closed allowed value (every older reader refuses it)" breaking fail 's/\(common.wire.v1.field\).allowed = "ops-v1"/(common.wire.v1.field).allowed = "ops-v2"/' "$OPS"
case_ "add an app to OpsStatus.app's open list (next)" breaking pass 's/(        "watch"\n)(      \]\n      open: true)/        "watch",\n        "next"\n$2/' "$OPS"
case_ "close OpsStatus.app (drop open)" breaking fail 's/(        "watch"\n      \]\n)      open: true\n/$1/' "$OPS"
case_ "close StartCanaryResult.reason (drop open)" breaking fail 's/(    format: "Code"\n)    open: true\n(    cases: \{\n      when: "paused")/$1$2/' "$OPS"
case_ "drop non_null from CanaryDelivery.state (a newer producer may write null)" breaking fail 's/(  State state = 1 \[\n    \(google.api.field_behavior\) = REQUIRED),\n    \(common.wire.v1.field\).non_null = true\n/$1\n/' "$OPS"
case_ "add a code to an open list (StartCanaryResult paused: consumer_paused)" breaking pass 's/          "endpoint_blocked"\n/          "endpoint_blocked",\n          "consumer_paused"\n/' "$OPS"
# An input's rule may loosen (the apps deploy before the dashboard), never tighten:
case_ "raise OpsReport.items max_items 20 -> 30 (an input accepts more)" breaking pass 's/\(common.wire.v1.field\).max_items = 20/(common.wire.v1.field).max_items = 30/' "$OPS"
case_ "lower OpsReport.items max_items 20 -> 10 (an input refuses older reports)" breaking fail 's/\(common.wire.v1.field\).max_items = 20/(common.wire.v1.field).max_items = 10/' "$OPS"
case_ "drop StartCanaryInput.run_id's format (an input accepts more)" breaking pass 's/(string run_id = 1 \[\n    \(google.api.field_behavior\) = REQUIRED),\n    \(common.wire.v1.field\).format = "RunId"\n/$1\n/' "$OPS"
case_ "give StartCanaryInput.run_id an allowed list (an input refuses older run IDs)" breaking fail 's/\(common.wire.v1.field\).format = "RunId"/(common.wire.v1.field) = {\n      format: "RunId"\n      allowed: "canary-1"\n    }/' "$OPS"
# A closed enum's values are fixed for the major version; buf (FILE) allows the new value.
case_ "add HEALTH_PARTIAL to the closed Health" breaking fail 's/(  HEALTH_DOWN = 3;\n)/$1  \/\/ Partly down.\n  HEALTH_PARTIAL = 4;\n/' "$OPS"
case_ "open the closed Health (drop closed)" breaking fail 's/(enum Health \{\n)  option \(common.wire.v1.closed\) = true;\n\n/$1/' "$OPS"
# Todofy's reports (todofy/report/v1, no service: every message is an output both ways): a case's empty list, a text
# format and the closed status are wire like any rule of an output.
case_ "let an empty window's recommendation carry tasks (drop its case's empty)" breaking fail 's/        rules: \{empty: true\}\n//' "$REPORT"
case_ "widen a task's title to 300 characters (the newsletter's own limit is higher)" breaking fail 's/max_length: 200/max_length: 300/' "$REPORT"
case_ "add REPORT_STATUS_PARTIAL to the closed ReportStatus" breaking fail 's/(  REPORT_STATUS_STALE = 4;\n)/$1  \/\/ Part of a report.\n  REPORT_STATUS_PARTIAL = 5;\n/' "$REPORT"
# mail.received.v1 (no service: every message is an output both ways): the relations between fields and a list written
# when empty are wire like any rule; a consumer's new optional field is not.
case_ "stop writing an empty warnings list (frozen bytes and payload hashes change)" breaking fail 's/repeated string warnings = 12 \[\(common.wire.v1.field\).write_empty = true\];/repeated string warnings = 12;/' "$MAIL"
case_ "drop original_text_bytes' present_when (a consumer would take a truncated text without its size)" breaking fail 's/    minimum: 0\n    present_when: "text_truncated"\n/    minimum: 0\n/' "$MAIL"
case_ "drop Mail's any_match (a blank subject and text would pass)" breaking fail 's/  option \(common.wire.v1.message\) = \{\n    any_match: \{\n      fields: \[\n        "subject",\n        "text"\n      \]\n      format: "Visible"\n    \}\n  \};\n\n//' "$MAIL"
case_ "add STORAGE_STATUS_EXPIRED to the closed StorageStatus (Todofy refuses it)" breaking fail 's/(  STORAGE_STATUS_OMITTED = 2;\n)/$1  \/\/ Expired.\n  STORAGE_STATUS_EXPIRED = 3;\n/' "$MAIL"
case_ "add an optional field to Mail (consumers skip what they do not know)" breaking pass 's/(  repeated Attachment attachments = 15 \[)/  \/\/ A newer flag.\n  optional bool newer_flag = 16;\n$1/' "$MAIL"
case_ "change a binding of the test fixtures (prototest is ignored, as by buf)" breaking pass 's/\{get: "\/v1\/\{parent=shelves\/\*\}\/books"\}/{get: "\/v2\/{parent=shelves\/*}\/books"}/' prototest/v1/prototest.proto
case_ "zero value without _UNSPECIFIED (MODE_UNSPECIFIED -> MODE_NONE)" lint fail 's/MODE_UNSPECIFIED = 0/MODE_NONE = 0/'
case_ "enum value without its prefix (SOURCE_LAB -> LAB)" lint fail 's/SOURCE_LAB = 1/LAB = 1/'
case_ "lowerCamelCase field (intent_id -> intentId)" lint fail 's/string intent_id = 3;/string intentId = 3;/; s/string intent_id = 3 /string intentId = 3 /'
case_ "undocumented field" lint fail 's/  \/\/ Tasks created so far.\n//'

echo "$failures unexpected verdict(s)"
[ "$failures" -eq 0 ]
