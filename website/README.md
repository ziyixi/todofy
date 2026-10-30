# ziyixi.science

Ziyi Xi's academic and engineering website. Next.js exports static pages from a validated content snapshot;
visitor requests never read Notion. `ziyixi-website` serves the site at `www.ziyixi.science` and `ziyixi.science`,
with `www` canonical. The separate relay dispatches content checks and holds no Notion credentials.

- [Architecture and route behavior](docs/architecture.md)
- [Release, recovery and receipt contract](docs/release.md)
- [Notion fields and local content setup](doc/setup-checklist.md)
- [Content-sync relay](relay/README.md), [verification limits](docs/verification.md)
- [Publication sources](doc/publication-sources.md), [imported commit map](docs/history-map.md)

## Build and check

From the repository root:

```sh
bazel test //website:check
bazel build //website:relay
```

`:check` runs units, formatting, ESLint, real type checks and the empty/fixture Chromium suites. The relay builds
independently of site content. `bazel build //website` requires an explicitly prepared `website_content` repository;
without one it fails. It never substitutes an empty blog for missing production content. The release workflow
captures Notion first and gives that snapshot to the same Bazel site target.

Package test/build/type/lint scripts delegate to Bazel. Tool versions come from the root workspace; see
[dependencies](../docs/dependencies.md) and [Bazel](../docs/bazel.md). Raw interactive Next/Wrangler development uses
pnpm dependencies and the no-argument proto materializer.

## Local content and preview

From `website/`, run `make install` once. For authorized real-content preview, configure `NOTION_TOKEN` and
`NOTION_DATA_SOURCE_ID` in ignored `.env.local`, then run `make preview`. This syncs content before opening the
Next development server. `make dev` uses the existing snapshot; `make sync` only synchronizes it.

Without Notion access, explicitly prepare synthetic or empty content:

```sh
pnpm content:prepare:fixture  # or content:prepare:empty
make dev
```

The content step writes `.generated/content/`, `public/media/`, `public/_img/` and `.generated/images.json`.
`make build-export` stages that prepared snapshot into Bazel and copies the static output to `out/`;
`make serve-export` serves it locally with Wrangler. Content capture and publication remain explicit operator
commands. They do not run in ordinary unit checks.

English and Chinese versions use distinct slugs and `Language` values, with the same optional `TranslationKey`.
[Notion setup](doc/setup-checklist.md#blog-fields) defines the publication fields and withdrawal rules.

## Production

Only main Actions publishes the site. Code changes, daily relay checks and Home's **立即同步** use the same release
lock and identity checks. A matching code/content/config identity records a successful check without uploading.
Changed releases verify the complete route contract before and after publication; failure follows the recorded
rollback path. Live deployment verification is the uncached `bazel run //website:verify_deployment` operator and
requires an explicit URL and expected build identity.

Notion is read only. Public Notion buttons and status write-back are retired. The production environment supplies
the website reader and Cloudflare credentials; neither snapshots nor credentials are committed.
