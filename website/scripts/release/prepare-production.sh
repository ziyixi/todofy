#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_dir}/../.." && pwd)"
# shellcheck source=./common.sh
source "${script_dir}/common.sh"

baseline_path=""
allow_empty=false
while (($#)); do
  case "$1" in
    --baseline)
      (($# >= 2)) || release_die "--baseline requires a path"
      baseline_path="$2"
      shift 2
      ;;
    --allow-empty)
      allow_empty=true
      shift
      ;;
    *) release_die "unknown argument: $1" ;;
  esac
done

[[ -n "$baseline_path" ]] || release_die "--baseline is required"
require_file "$baseline_path"
require_env SITE_URL
require_command jq
require_command pnpm

cd "$repository_root"
config_json="$(node --import tsx --eval '
  import { siteConfig } from "./content/site.config.ts";
  process.stdout.write(JSON.stringify({
    canonicalOrigin: siteConfig.canonicalOrigin,
    blogSource: siteConfig.blogSource,
    notionApiVersion: siteConfig.notion.apiVersion,
  }));
')"

source_mode="$(jq -er '.blogSource' <<<"$config_json")"
canonical_origin="$(jq -er '.canonicalOrigin' <<<"$config_json")"
configured_notion_version="$(jq -er '.notionApiVersion' <<<"$config_json")"

assert_https_origin "$canonical_origin"
[[ "$SITE_URL" == "$canonical_origin" ]] ||
  release_die "SITE_URL does not exactly match content/site.config.ts canonicalOrigin"

case "$source_mode" in
  empty)
    [[ "$allow_empty" == false ]] ||
      release_die "--allow-empty is meaningful only for an intentional Notion collection clear"
    release_note "preparing the explicit production source: empty"
    env -u NOTION_TOKEN -u NOTION_DATA_SOURCE_ID \
      pnpm content:prepare --source=empty --baseline="$baseline_path" --for-release
    ;;
  notion)
    require_env NOTION_TOKEN
    require_env NOTION_DATA_SOURCE_ID
    require_env NOTION_API_VERSION
    [[ "$NOTION_API_VERSION" == "$configured_notion_version" ]] ||
      release_die "NOTION_API_VERSION does not match the version pinned in site.config.ts"
    release_note "preparing the explicit production source: notion"
    prepare_args=(--source=notion --baseline="$baseline_path" --for-release)
    if [[ "$allow_empty" == true ]]; then
      prepare_args+=(--allow-empty)
      release_note "trusted one-run confirmation allows the public Notion collection to become empty"
    fi
    pnpm content:prepare "${prepare_args[@]}"
    ;;
  fixture)
    release_die "fixture content is forbidden in the production release entrypoint"
    ;;
  *)
    release_die "unsupported production blogSource: ${source_mode}"
    ;;
esac

pnpm content:validate
write_github_output source_mode "$source_mode"
