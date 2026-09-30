# ziyixi.science

Personal academic and engineering website for Ziyi Xi: Next.js App Router, built as a **static export**
from a validated, immutable content snapshot. Blog posts come from a Notion data source; visitor requests
never reach Notion or any Worker code.

| Part        | What it is                                                                                                                                                 | Docs                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| The site    | `next build` with `output: "export"` → `out/`, served by the assets-only Worker **`ziyixi-website`** ([`wrangler.toml`](wrangler.toml))                    | [`docs/architecture.md`](docs/architecture.md) |
| The release | `.github/workflows/website-release.yml` (repository root): Notion sync, build, verify, Worker version upload/deploy, live check, rollback, Notion feedback | [`docs/release.md`](docs/release.md)           |
| The relay   | Worker **`ziyixi-notion-publish`** ([`relay/`](relay/)): the Notion buttons and the 15-minute change detector that publishes automatically                 | [`relay/README.md`](relay/README.md)           |
| The cutover | Preview hostname → `www` → apex redirect; rollback to Vercel                                                                                               | [`docs/cutover.md`](docs/cutover.md)           |

This directory is one app of the monorepo (root [`README.md`](../README.md), [`AGENTS.md`](../AGENTS.md)). It
was the separate repository `ziyixi/ziyixi.science` until 2026-09-30; its history is kept
(`git log --follow website/<file>`, old commit IDs in [`docs/history-map.md`](docs/history-map.md)). The
Chinese planning and operations notes in [`doc/`](doc/) describe the Vercel era where they mention Vercel;
the files in `docs/` supersede them.

## Local development

Use Node 24 and the pnpm version declared in `package.json` (`corepack enable`, or `make` picks a Homebrew
`node@24`). Run `make install` once.

For your real Notion articles, configure `NOTION_TOKEN` and `NOTION_DATA_SOURCE_ID` in `.env.local`, then:

```bash
make preview        # sync Notion, then the Next dev server on http://localhost:3000
```

| Command              | What it does                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `make preview`       | Sync Notion, then start the development server                                                 |
| `make sync`          | Sync Notion without starting a server                                                          |
| `make dev`           | Start the development server on the existing snapshot                                          |
| `make build-export`  | Build the static export `out/` from the existing snapshot                                      |
| `make serve-export`  | Build `out/` and serve it exactly as production does (`wrangler dev`, <http://127.0.0.1:4173>) |
| `make check`         | Formatting, lint, type checks and unit tests                                                   |
| `make notion-status` | Compare Notion with the live site and write the feedback (writes to Notion)                    |

The content step (`make sync`, `pnpm content:prepare*`) writes `.generated/content/`, `public/media/` and the
responsive image variants `public/_img/` with their map `.generated/images.json`. Every Next.js command
needs a prepared snapshot. Without Notion credentials use the empty blog or the synthetic fixture:

```bash
pnpm content:prepare:fixture   # or content:prepare:empty
make dev
```

For bilingual articles, give the English and Chinese pages the same optional `TranslationKey`, distinct
slugs and `Language` `en` / `zh-CN` ([Notion setup](doc/setup-checklist.md#11-创建专用-blog-数据库),
[publication sources](doc/publication-sources.md)).

## Checks

What `Website checks` runs in CI, without any secret:

```bash
pnpm content:prepare:empty && pnpm check
for mode in empty fixture; do
  pnpm content:prepare:$mode && pnpm content:validate --source=$mode
  pnpm build:site                 # next build + out/_headers, out/_redirects, asset limits
  CI=1 CONTENT_MODE=$mode pnpm test:e2e   # Playwright against `pnpm start` (wrangler dev on out/)
done
pnpm exec wrangler deploy --dry-run --config wrangler.toml
pnpm exec wrangler deploy --dry-run --config relay/wrangler.toml
```

`pnpm test:deployment` (the release's route contract) needs `DEPLOYMENT_BASE_URL` and an expected
`build-info.json`; fixture content is allowed only against a local server with
`ALLOW_FIXTURE_DEPLOYMENT_TESTS=true`.

## Production

Deploys run only from GitHub Actions on `main` (never from a laptop): a website change on `main` runs
`Website deploy` after the CI gate, which dispatches `website-release.yml` just as the Notion buttons and
the relay's detector do (every release builds the newest `main` commit that passed the CI gate), and a `website/relay/` change runs `Website relay deploy`. The GitHub `production` environment
holds `WEBSITE_NOTION_TOKEN`, `WEBSITE_NOTION_DATA_SOURCE_ID` and the monorepo's `CF_API_TOKEN`; every
other production value is committed (`wrangler.toml`, `relay/wrangler.toml`, the workflow's `env`).
