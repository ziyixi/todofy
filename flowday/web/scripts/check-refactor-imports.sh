#!/usr/bin/env bash

set -euo pipefail

pattern='from "@/components/layout/app-shell"|from "@/components/flow/day-flow"|from "@/components/flow/progress-bar"|from "@/components/settings/settings-dialog"|from "@/components/settings/export-dialog"|from "@/components/timer/manual-entry"|from "@/components/analytics/analytics-dashboard"|from "@/features/layout/hooks/use-flowday-e2e-bridge"|from "@/lib/test/e2e"|from "@/lib/stores/flow-store"|from "@/lib/stores/timer-store"|from "@/lib/stores/todoist-store"|from "@/lib/db/queries"'

# grep -E instead of rg: ripgrep is not on every CI runner image.
if grep -rnE "$pattern" app components features lib __tests__; then
  echo
  echo "Deprecated import paths found. Import the feature/query modules directly."
  exit 1
fi

echo "Import audit passed."
