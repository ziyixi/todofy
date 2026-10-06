# Architecture

Two Cloudflare Workers on Workers Free, deployed from GitHub Actions. Visitor requests use static
assets only. The relay dispatches a daily content sync and accepts the Home owner's manual sync through
a private service binding; only Actions reads Notion and builds the website.

```text
Notion Blog (Draft / Published)
  │ full snapshot read, once per release
  ▼
website-release.yml ◄── daily relay / Home 立即同步 / code push / manual recovery
  │ green commit → snapshot → compare identity
  │ unchanged: successful check receipt, no deploy
  │ changed: build → verify → upload → deploy → live verify (rollback on failure)
  ▼
Website Worker (static assets only)
  └── GitHub website-release ledger + website-content-sync check receipts → Home status
```

## Hostnames

Current state (since 2026-10-01): `www.ziyixi.science` and the apex `ziyixi.science` are the two Workers
Custom Domains of `ziyixi-website`, listed in [`wrangler.toml`](../wrangler.toml), and both serve the same
static site. `www` is canonical: every page carries `<link rel="canonical">` to `https://www.ziyixi.science`,
and the feed, sitemap and Open Graph URLs use it. The apex answers with the same pages (status 200, no
redirect). Nothing else is attached to the Worker: no zone route, no preview host, no `*.workers.dev`. The
apex keeps its MX, SPF/`apple-domain` TXT, `_dmarc` and DKIM records; never touch them.

`routes` in `wrangler.toml` is the Worker's complete set of Custom Domains: each release's
`wrangler triggers deploy` replaces the attached set with it (a no-op while the two agree), so the file must
always match the live state. Removing a line detaches that hostname at the next release; adding one creates
its DNS record and certificate. The release's hostname guard ([`tools/cf-guard`](../../tools/cf-guard/README.md))
refuses a removal, and an addition that would take over another Worker's hostname or an existing DNS
record (or whose DNS records its token cannot read), unless the release step allows that exact hostname. The release verifies the whole route contract on `www` and the build
identity on the apex ([`release.md`](release.md)).

**Why both are Custom Domains (2026-10-01).** Until then `www` was a zone route (`www.ziyixi.science/*`) in
front of the old Vercel CNAME and the apex a zone route (`ziyixi.science/*`) to the separate Worker
`ziyixi-apex-redirect`, which answered a 308 to `www`. The apex had no certificate of its own: Cloudflare
served it whichever certificate listed the apex, and every Workers Custom Domain's certificate
(`mail-hero`, `home`, `todofy`, …) lists the zone apex, so that choice changed whenever a Custom
Domain was added. Chrome reuses (coalesces) an HTTP/2 or HTTP/3 connection for another hostname that
resolves to the same IPs when the certificate it saw on that connection covers the new hostname. Cloudflare's
edge rejects a request whose `Host` is not covered by the certificate it currently maps to the connection's
SNI (over HTTP/3: an empty `403` with `cache-control: private, no-store`). So a desktop Chrome that had
opened the apex got empty 403s on `mail-hero`, `lab` and `www` until its sockets were flushed. Now the apex
and `www` share one dedicated certificate (SANs `ziyixi.science`, `www.ziyixi.science`,
`*.www.ziyixi.science`) that covers none of the app hosts, so an app request is never coalesced onto a site
connection. The old Vercel-era records (apex A `76.76.21.21`, `www` CNAME `cname.vercel-dns.com`), both
zone routes and the preview Custom Domain `website-preview.ziyixi.science` were deleted, and
`ziyixi-apex-redirect` (formerly `website/apex-redirect/`) was retired. The dashboard links and probes
`www` (canonical) for the same reason.

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
  `/publication-state.json` (the release verifier and the Home status reader read them and refuse cached
  answers); `application/rss+xml; charset=utf-8` on `/feed.xml`; `immutable` on the content-addressed
  `/_next/static/*`, `/media/*` and `/_img/*`.
- **Redirects** (`out/_redirects`): the snapshot's slug-change and configured redirects as literal 308
  rules, each also in its trailing-slash form (`/blog/old/` → new slug; Vercel reached it through its own
  slash 308), plus `<path>/ → <path>` 308 for every canonical page, post and feed path (validated again: no
  placeholders or splats, internal targets, at most 2,000 lines). Redirects run before assets and
  html_handling. A lowercase percent-encoded old URL first gets the platform's 307 to the uppercase form,
  then the 308. Rules here cannot match a host, so the apex is not redirected: it serves the same pages,
  whose canonical links name `www` (see Hostnames).
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

## Daily content sync

The relay dispatches one ordinary release per day. Home offers **立即同步** for a quicker update. Both
use the same release workflow and concurrency lock as code pushes. There is no Notion change detector,
public webhook button, status-only workflow or GitHub fallback schedule. The relay does not need a
Notion token; Draft/Published and content remain in the Actions snapshot pipeline.

The complete snapshot is hashed on every release, including child blocks and media. A matching identity
creates a successful content-check receipt and skips the build/deploy. A changed identity becomes
successful only after the live hostname serves the verified release. GitHub run state, content-check
receipts, the accepted release ledger and live identity are read together to show actual progress and
failures in Home. See [release stages and receipt contract](release.md).

## Costs (Workers Free)

Static asset requests are free and do not run Worker code. The relay has one daily scheduled invocation
plus owner actions/status reads. Notion content downloads and builds run in GitHub Actions on standard
public-repository runners. No new Durable Object or paid scheduling service is required.

The live site has no analytics beacon today (checked 2026-09-30: no `cloudflareinsights` in the HTML of any
page); adding Cloudflare Web Analytics would be a separate owner decision, not part of the migration.
