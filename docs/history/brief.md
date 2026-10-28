# Brief (retired)

Brief was a daily research-and-world briefing in Chinese for the owner: a weekday email and a Saturday deep read,
written from public feeds and pages that its Worker fetched itself, screened and written with Claude through Model
Router, with every quote, name and number checked in code. It was one Worker and one SQLite Durable Object
(`BriefState`) on Workers Free, with an archive UI behind Access at `brief.ziyixi.science`. It joined the monorepo on
2026-10-11 (`0e48a599`) and was first deployed that day in archive mode (`7bea3ec4`), which sends no email; Home
monitored it through its `Ops` entrypoint. It ran in that mode until it was stopped on 2026-10-18 (`BRIEF_MODE=off`).

The owner decided on 2026-10-28 to retire it: its useful part, the source collection, moved into Newsletter's
researcher (`newsletter/content-config/researcher.yaml`, ported from Brief's registry), and Newsletter stays the one
daily briefing. No data moved: the Durable Object's state (sources' health, items, issues, votes and ledgers) is
deleted with the Worker. The release that merged `claude/retire-brief` removed the app. The last commit with its
source and documents is `c928f889` (`git show c928f889:brief/README.md`); its owner API `brief.ui.v1` is listed in
`proto/retired.json`.

| Part | Replaced by |
| --- | --- |
| Source registry, fetch etiquette and interest profile (`brief/content-config/`, `brief/worker/src/fetch/`) | Newsletter's researcher registry and fetcher, reimplemented there; Brief's dropped entries stay readable at `c928f889` |
| The Worker `brief`, its archive UI and owner API | Nothing; Newsletter's editions and its Notion archive |
| `Brief checks`, `Brief deploy` and Home's 简报 tile, Ops binding and guard | Nothing |
| Brief as a Model Router caller | Nothing; its recorded requests stay in Router's history |
| The Access applications `brief` and `brief-feedback` and the feedback policy | Deleted by "Infra apply" through `infra/retired.tf` ([Retiring an app](../../infra/README.md#retiring-an-app)) |
| The Worker script with its Durable Object and Custom Domain, and the GitHub `BRIEF_*` settings | Deleted by hand, as the release's HANDOFF steps say |
