# ziyixi.science

Personal academic and engineering website for Ziyi Xi. It is built with Next.js App Router and reads a validated, immutable content snapshot at build time. Visitor requests never call Notion.

## Local development

Use Node 24 and the pnpm version declared in `package.json`. Run `make install` once if dependencies are not installed.

If your Mac has a different Node version, install [Homebrew's Node 24](https://formulae.brew.sh/formula/node@24) once:

```bash
brew install node@24
```

Make uses the current Node if it is version 24; otherwise it selects an installed Homebrew `node@24` for its commands. This does not change your shell's default Node. With nvm, run `nvm install && nvm use` using the included `.nvmrc`. Make checks the runtime before syncing Notion. Direct `pnpm` commands still use your shell's Node; to run those with Homebrew Node 24, first use `export PATH="$(brew --prefix node@24)/bin:$PATH"` in that terminal.

For your real Notion articles, configure `NOTION_TOKEN` and `NOTION_DATA_SOURCE_ID` in `.env.local`, then run:

```bash
make preview
```

Open <http://localhost:3000>. Stop with Ctrl+C. To use another port, run `make preview PORT=3001`.

| Command        | What it does                                                  |
| -------------- | ------------------------------------------------------------- |
| `make preview` | Sync Notion, then start the local development server          |
| `make sync`    | Sync Notion without starting a server                         |
| `make dev`     | Start the server using the existing snapshot, without syncing |
| `make check`   | Run formatting, lint, type checks, and unit tests             |
| `make help`    | Show the available commands                                   |

The sync command loads `.env.local` automatically and writes to `.generated/content/` and `public/media/`. It uses the existing local registry when available and handles first-time bootstrap automatically. A sync error stops `make preview` before the server starts. These commands do not publish anything or change `content/site.config.ts`.

After editing Notion, stop the server and run `make preview` again. The website reads a snapshot; it does not fetch Notion on each page visit. Use `make dev` when you only want to work with the already synced content.

For bilingual articles, create an optional Text property named `TranslationKey` in the Notion database. Give the English and Chinese pages the same key, distinct slugs, and `Language` values `en` / `zh-CN`. Lists show one entry with both titles and language links; article pages have a language switch. Unpaired articles work without this property. See [the Notion setup guide](doc/setup-checklist.md#11-创建专用-blog-数据库) for the full field table and [publication sources](doc/publication-sources.md) for the verified bibliography.

Local preview works while the production `blogSource` is still `empty`. Before a production build with Notion content, set `blogSource: "notion"` in `content/site.config.ts` and run `make sync` again. Keep `SITE_URL` set to the canonical production origin if specified, even during local preview. Release baseline handling remains separate from this local workflow.

To preview without Notion credentials, prepare an empty blog or representative synthetic content:

```bash
# Choose one:
pnpm content:prepare:empty
pnpm content:prepare:fixture
make dev
```

The fixture is synthetic and is never an automatic production fallback. Production mode is selected explicitly in `content/site.config.ts`.

## Checks

```bash
pnpm content:prepare:empty
pnpm check
pnpm content:validate --source=empty
pnpm exec next build
pnpm content:prepare:fixture
pnpm content:validate --source=fixture
pnpm exec next build
CONTENT_MODE=fixture pnpm test:e2e
```

Offline checks explicitly select their empty or fixture snapshot, independently of the production setting. For a real production build, run `make sync` followed by `pnpm build`; the normal build command strictly validates the configured production source before building.

`pnpm test:e2e` starts the production server in CI after a build; local runs use the development server unless `DEPLOYMENT_BASE_URL` is supplied by the trusted deployment verifier. `pnpm test:deployment` is intentionally invalid without that explicit URL and release identity.

The committed production mode is `notion`. It requires a read-only integration, the configured data source schema, an explicit trusted baseline, and a complete media/content sync. It never falls back to fixture or empty content after a sync failure.

See `doc/plan.md` for the full architecture and `doc/operations.md` for the release, migration, and rollback runbook. Account setup, production secrets, a real Notion data source, domain migration, and deployment remain separate authorized operations.
