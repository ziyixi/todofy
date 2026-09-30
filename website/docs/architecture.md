# Architecture

Three Cloudflare Workers on Workers Free, all deployed only from GitHub Actions, plus the build and the
Notion write-back in GitHub Actions. No Worker ever renders a page or reads Notion content at request
time.

```
Notion Blog data source ──(read: sync)──────────────┐
   ▲  │                                             │
   │  └─(buttons: Send webhook + secret header)──►  Worker ziyixi-notion-publish (relay/)
   │                                                   fetch(): /publish /refresh-status
   │                                                   scheduled(): every 15 min, change detector
   │                                                   │ workflow_dispatch, fixed inputs
   │                                                   ▼
   │                     .github/workflows/website-release.yml (concurrency group website-production)
   │                        ◄── also dispatched by ci.yml "Website deploy" after a website push on main
   │                        Notion sync → next build (export) → wrangler dev verify → versions upload
   │                        → versions deploy → triggers deploy → live verify → rollback on failure
   └──(write: feedback)──── Notion status properties + database description
                                                       ▼
                               Worker ziyixi-website (assets only, wrangler.toml)
                               website-preview.ziyixi.science (Custom Domain)
                               www.ziyixi.science/* (zone route on the proxied www record)
                               ziyixi.science/* ─ Worker ziyixi-apex-redirect (apex-redirect/):
                                                  308 → https://www.ziyixi.science + path + query
```

## The site: static export on Workers Static Assets

- `next build` with `output: "export"` writes `out/`: one HTML file per route (`blog.html`,
  `blog/<slug>.html`), the RSC segment payloads (`**/__next.*.txt`) that client navigation fetches,
  `build-info.json`, `publication-state.json`, `feed.xml`, `sitemap.xml`, `robots.txt`, `404.html`. All
  routes were already static on Vercel (`dynamicParams = false`, `force-static` route handlers); only
  `robots.ts` and `sitemap.ts` needed `dynamic = "force-static"`.
- The Worker has no script (`wrangler.toml` has no `main`). Requests for static assets are free and do not
  count against the Workers Free request or CPU limits. `html_handling = "auto-trailing-slash"` serves
  `/blog` from `blog.html`; the trailing-slash form of every canonical page and feed path (`/blog/`,
  `/blog/<slug>/`, `/feed.xml/`, …) is a **308** from `_redirects` (below), as on Vercel, and only
  `.html` forms such as `/blog.html` get html_handling's 307. `not_found_handling = "404-page"` answers
  unknown paths with `404.html` and status 404. `finalize.ts` removes Next's internal `_not-found` copy,
  so `/_not-found` is a 404 too.
- **Known differences from Vercel** (accepted): `/404` answers the not-found page with status **200**
  (auto-trailing-slash serves `404.html` for it; only a Worker script could change that; the page is
  `noindex`); `OPTIONS` answers 405 instead of 204 (simple cross-origin GETs need no preflight); old
  `/_next/image?url=…` URLs answer 404 (see Images).
- `workers_dev = false` and `preview_urls = false`: no `*.workers.dev` copy and no public per-version URL.
- **Headers** (`out/_headers`, from [`scripts/export/site-files.ts`](../scripts/export/site-files.ts)):
  exactly the headers `next.config.ts headers()` sent on Vercel on every path (Referrer-Policy,
  X-Content-Type-Options, X-Frame-Options DENY, Permissions-Policy), plus
  `Strict-Transport-Security: max-age=63072000` (what Vercel sent; the zone's own HSTS is off; no
  includeSubDomains or preload, other subdomains are separate apps) and `Access-Control-Allow-Origin: *`
  (Vercel sent it on every static response; browser-based feed readers rely on it); `no-store` on `/build-info.json` and
  `/publication-state.json` (the release verifier and the Notion status check read them and refuse cached
  answers); `application/rss+xml; charset=utf-8` on `/feed.xml`; `immutable` on the content-addressed
  `/_next/static/*`, `/media/*` and `/_img/*`.
- **Redirects** (`out/_redirects`): the snapshot's slug-change and configured redirects as literal 308
  rules, each also in its trailing-slash form (`/blog/old/` → new slug; Vercel reached it through its own
  slash 308), plus `<path>/ → <path>` 308 for every canonical page, post and feed path (validated again: no
  placeholders or splats, internal targets, at most 2,000 lines). Redirects run before assets and
  html_handling. A lowercase percent-encoded old URL first gets the platform's 307 to the uppercase form,
  then the 308. The apex → www redirect cannot live here (no host rules); it is the Worker `ziyixi-apex-redirect`
  ([`apex-redirect/`](../apex-redirect/README.md)) on the zone route `ziyixi.science/*`.
- **Limits** checked by `scripts/export/finalize.ts`: at most 20,000 files per version and every file
  under 25 MiB (Workers Free static assets). The Notion media downloader caps video and attachments at
  24 MiB (images 20 MiB) to stay below it.

## Images

There is no request-time image optimizer (Vercel's `/_next/image` is gone), so the content step makes the
variants at build time ([`scripts/images/prepare.ts`](../scripts/images/prepare.ts)):

- Sources: the profile portrait and every PNG/JPEG/WebP article image of the snapshot. For each, WebP files
  (quality 75) at every configured width below its own width, plus its own width, named
  `/_img/<first 20 hex of sha256(source)>-<width>.webp`; stale variants are removed.
- Widths ([`src/lib/images/config.ts`](../src/lib/images/config.ts)): `imageSizes` 64/128/160/256/320
  (the portrait is 128 or 160 CSS px) and `deviceSizes` 384–1360 (article images are at most 680 CSS px,
  2x on high-density screens). `next/image` only ever asks for these widths.
- The custom loader ([`src/lib/images/loader.ts`](../src/lib/images/loader.ts)) maps `(src, width)` to the
  smallest variant at least that wide, from `.generated/images.json`. Unknown sources (GIF, SVG, external)
  keep their original URL. The lightbox still opens the original `/media/<sha256>.<ext>`.
- Measured (2026-09-30, a read-only Notion sync whose `contentHash` equals the live site's):
  - the homepage portrait `profile/ziyixi-headshot-2026.png`, 1122 × 1402, is 2,782,888 B; the 160w
    variant is 2,416 B and the 320w variant (a 160 px slot on a 2x screen) 6,050 B. Vercel served about
    8 KB; without variants the export would ship the 2.78 MB PNG;
  - the 10 article images (703–3022 px wide) are 1,465,313 B as originals; the variants an article page
    loads are 94,360 B at 1x (750w, 6.4 %) and 190,740 B at 2x (1360w, 13.0 %); the largest original,
    476,575 B, becomes 15,454 B / 41,798 B;
  - the whole export with that content: 270 files, 9.9 MB (`wrangler deploy --dry-run` reads 285 files,
    counting `_headers` and `_redirects` and wrangler's own manifest entries).
- The Open Graph image is still the original portrait PNG (crawlers fetch it rarely).
- Old image URLs: Vercel's pages referenced `/_next/image?url=…&w=…&q=75`; those URLs answer 404 after the
  cutover (`_redirects` cannot match a query string). Only image-search entries and external hotlinks to
  them break; every page links the new `/_img/` variants. Keeping them would need a small Worker script
  (`run_worker_first` on `/_next/image`) that maps `url=` to the original or a variant; accepted as is.

## Release state

GitHub Deployment records (task `website-release`, environment `production`) in this repository hold the
state between releases: the Worker version, its predecessor, the live hostname, the content registry (slug
history and feed GUIDs, which drive automatic slug-change redirects and the non-empty → empty guard) and
the route contract. See [`release.md`](release.md).

## Automatic releases

The relay's `scheduled()` handler runs every 15 minutes (`7,22,37,52 * * * *`; the account's third of five
Workers Free cron triggers, after `home` and `todofy`). Each tick normally makes three subrequests (at most
five) and keeps no state of its own:

1. **GitHub**: list the newest 50 runs of `website-release.yml` on `main`. If one is queued or running,
   stop (`RUN_ACTIVE`). The newest release run (any trigger, any outcome) defines the window: `since` = its
   start, `finishedAt` = its last update. Its trigger is read from the run name
   `Website <operation> (<trigger>)`.
2. **Notion**: a data-source query (page size 100, newest edit first) for rows that were edited since
   `since` − 1 minute (Notion reports edit times to the minute), or are `待定时发布` with `PublishedAt` ≤
   **now** (an instant, not "today": a date-only date is due at UTC midnight, exactly as the build reads
   it), or are `有修改待发布` / `待下线`. Only the rule fields are read. Every release's write-back edits
   every row, so right after one every row matches: the detector reads a second result page if there is
   one, and if still more rows match, one more query for only the due and pending rows (the newest edits,
   the only ones that can be author edits, are already on the first pages).
3. **Rules**:
   - an _author edit_ is a row edited since `since` whose last edit is not the status write-back (the
     write-back records each row's `检查时间` as the instant of that row's own write, so its edit lands
     within seconds of it, however long the check's content read took; an edit between that minute and
     three minutes later is the bot's; `IGNORED_EDITOR_IDS` can list more editors) and that is not a draft
     that was never public;
   - a _due post_ is `待定时发布` whose `PublishedAt` passed after `since` (a release that started after it
     became due already published it);
   - a _pending state_ is `有修改待发布`/`待下线` written by a check after `finishedAt`, i.e. a 刷新状态 run
     that found changes a bot edit had masked;
   - a _follow-up_ is such a state written by the newest release's own write-back (between `since` and
     `finishedAt`): the author changed the row while that release ran, after its Notion snapshot, and the
     write-back's edit masked the author's edit time. It dispatches one release with `trigger=pending`;
     states written by a `pending` release never count, so a release that cannot converge re-triggers
     itself at most once;
   - **quiet period**: nothing is dispatched while the newest author edit (or pending check) is less than
     25 minutes old (`QUIET_MINUTES`);
   - **circuit breaker**: at most 6 automatic (`trigger=cron` or `pending`) releases per UTC day
     (`MAX_AUTO_RELEASES_PER_DAY`), then `AUTO_CAP_REACHED`;
   - **failure stop**: after 3 failed release runs in a UTC day (for example a blocked gate that needs
     `recovery`), nothing more is dispatched that day (`FAILURES_TODAY`); each failure already sent
     GitHub's notification;
   - **daily reconcile**: the first tick at or after 10:00 UTC (`RECONCILE_UTC_HOUR`) without a
     `reconcile` run today dispatches one release anyway. It catches what the rules cannot see: a failed
     release's earlier edits, edits to synced blocks elsewhere, and child-block edits that do not move the
     page's edit time.
4. **Dispatch**: `operation=release`, `confirmation=release:www.ziyixi.science`, `force_build=false`,
   `allow_empty=false`, `trigger=cron|pending|reconcile`. The release skips the deploy when the identity did not
   change, so a reconcile on an unchanged day costs one short Actions run and refreshes the Notion feedback.

`AUTO_PUBLISH = "false"` in `relay/wrangler.toml` turns the detector off (buttons keep working). Known
limits: a failed release does not write feedback, so edits made before it wait for the reconcile (the
failed run's GitHub notification is the alert); a dispatch PAT that expires makes every tick log
`GITHUB_UNAVAILABLE`/`DISPATCH_FAILED` (Workers Logs) and the buttons answer 502.

## Costs (Workers Free)

Page views: static assets, free and unlimited (also through the `www` route). Apex redirect: one Worker
request per apex hit (links point at www, so few), well under 1 ms CPU, no subrequest. Relay: 96 scheduled invocations and normally ~290 subrequests a
day (at most 5 per tick) plus the button clicks, each far under 10 ms CPU for a blog of this size. GitHub Actions: public repository, standard runners.
The live site has no analytics beacon today (checked 2026-09-30: no `cloudflareinsights` in the HTML of any
page); adding Cloudflare Web Analytics would be a separate owner decision, not part of the migration.
