# Cutover runbook: Vercel → Cloudflare

For the lead. Every step keeps `www.ziyixi.science` answering; each has a rollback. Vercel is not touched
until the cleanup at the end, so it stays the fallback (frozen at its last release: after step 1 new Notion
content goes only to the Worker).

State before the cutover (2026-09-29): the zone is on Cloudflare (Free, DNSSEC). `www` is a proxied CNAME to
`cname.vercel-dns.com`; the apex is a proxied A `76.76.21.21` (Vercel, which answers 308 → www) next to the
iCloud MX, SPF/`apple-domain` TXT, `_dmarc` and `sig1._domainkey` records. **Never touch the MX, TXT or
DKIM records.** The account uses 2 of its 5 Workers Free cron triggers (`home`, `todofy`); the relay adds the
third.

## 0. Before merging the branch

1. **Dispatch token.** github.com/settings/personal-access-tokens → the fine-grained token in the relay's
   `GITHUB_DISPATCH_TOKEN` → Repository access: add **ziyixi/todofy** (keep Actions: Read and write;
   keeping ziyixi.science too means the old buttons keep working until the merge). Or create a new token for
   ziyixi/todofy only and put it in the relay (next item) and in `.env.local`. Check its expiry date there.
2. **Relay secrets** (Worker `ziyixi-notion-publish`; the two existing ones stay). Preferably first create
   a Notion internal integration with only _Read content_, share the Blog database with it, and use its
   token; the website's write-back token also works. From `website/`, with a Cloudflare login or
   `CLOUDFLARE_API_TOKEN` in your shell:

   ```sh
   npx wrangler secret put NOTION_TOKEN --config relay/wrangler.toml
   npx wrangler secret put NOTION_DATA_SOURCE_ID --config relay/wrangler.toml
   # only if you created a new dispatch token:
   npx wrangler secret put GITHUB_DISPATCH_TOKEN --config relay/wrangler.toml
   ```

   (`wrangler secret put` on the existing Worker deploys nothing else.)

3. **GitHub `production` environment of ziyixi/todofy**: two secrets for the release (the values are the
   ones in the old repository's `Production` environment and in `.env.local`; this pipes them without
   printing):

   ```sh
   ENVF="$HOME/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/.env.local"
   val() { python3 -c 'import sys;[sys.stdout.write(l.rstrip("\n").split("=",1)[1]) for l in open(sys.argv[1]) if l.startswith(sys.argv[2]+"=")]' "$ENVF" "$1"; }
   val NOTION_TOKEN          | gh secret set WEBSITE_NOTION_TOKEN          -R ziyixi/todofy --env production
   val NOTION_DATA_SOURCE_ID | gh secret set WEBSITE_NOTION_DATA_SOURCE_ID -R ziyixi/todofy --env production
   ```

   `CF_API_TOKEN` is already there (it deploys Todofy and the dashboard). `SITE_URL` and
   `NOTION_API_VERSION` are committed in the workflow; no variable is needed.

4. **Zone rules**: Cloudflare dashboard → ziyixi.science → Rules → Overview. Note any Redirect, Transform,
   Cache or Page Rule that matches `www` or the apex (the deploy token cannot read rulesets). A cache rule on
   `*.json` or `robots.txt` must not override the Worker's `no-store`.

## 1. Merge, then bootstrap

1. Merge to `main`. CI runs `Website checks`, then `Website deploy` (its gate finds no release record and
   stops green with the notice "dispatch bootstrap") and `Website relay deploy` (the relay now targets
   ziyixi/todofy and gets its cron). The Notion buttons keep their URL.
2. Actions → **Website release** → Run workflow: operation `bootstrap`, confirmation
   `bootstrap:www.ziyixi.science`. It continues the content registry of the last successful Vercel release
   (read from ziyixi/ziyixi.science's public Deployments), builds from Notion, verifies under `wrangler dev`,
   creates the Worker `ziyixi-website` with `wrangler deploy` (no hostname, nothing public) and records
   `success`. The Notion feedback is skipped: nothing live to compare yet.

Rollback: nothing public changed. `AUTO_PUBLISH = "false"` in `website/relay/wrangler.toml` stops automatic
releases if needed.

## 2. Preview hostname

1. In `website/wrangler.toml`, one line:

   ```toml
   routes = [{ pattern = "website-preview.ziyixi.science", custom_domain = true }]
   ```

   Push to `main`. The release deploys the version, `wrangler triggers deploy` creates the Custom Domain
   (DNS record and certificate; `CF_API_TOKEN` did the same for `home.ziyixi.science`), waits until it
   answers, verifies the identity three times and the whole route contract on it, and from now on writes
   the Notion feedback against it.

2. Look at it: <https://website-preview.ziyixi.science> (portrait sharp and small, article images,
   lightbox, feed, `/nope` → 404). `curl -sI https://website-preview.ziyixi.science/build-info.json` shows
   `cache-control: no-store, max-age=0` and `strict-transport-security: max-age=63072000`. Click 刷新状态
   and 发布网站 once; both runs appear under Actions → Website release.

Rollback: remove the line and push (the next release detaches the hostname).

## 3. www

1. Change the line to list both hostnames (keep the preview host or drop it later):

   ```toml
   routes = [
     { pattern = "www.ziyixi.science", custom_domain = true },
     { pattern = "website-preview.ziyixi.science", custom_domain = true },
   ]
   ```

   Push to `main`. Run non-interactively, `wrangler triggers deploy` replaces the existing `www` CNAME to
   Vercel with the Worker's Custom Domain record in one API call (wrangler 4.142 sets
   `override_existing_dns_record` outside a terminal). There is no moment without a `www` record. From now
   on the release verifies on `https://www.ziyixi.science`.
   _Not verified:_ whether `CF_API_TOKEN` may replace an existing DNS record. If the release's deploy step
   fails there, the release rolls the version back and records a failure while `www` still serves Vercel;
   then attach `www.ziyixi.science` in the dashboard (Workers → ziyixi-website → Settings → Domains &
   Routes → Add → Custom Domain, and accept replacing the existing record) and dispatch Website release
   with operation `recovery`.

2. Check at once: `curl -sI https://www.ziyixi.science/` has no `x-vercel-id`;
   `curl -s https://www.ziyixi.science/build-info.json` shows the Worker's `contentHash` (the same as the
   preview host); `robots.txt`, `build-info.json` and `publication-state.json` are not rewritten by the zone
   cache (`cache-control` as in step 2); HSTS present; `/blog/` → 307 `/blog`; `/nope` → 404;
   `/feed.xml` is `application/rss+xml`. View the page source in a browser: the Cloudflare Web Analytics
   beacon (`static.cloudflareinsights.com/beacon.min.js`) should still be injected; if it is not, add the
   public snippet from the Web Analytics page to `src/app/layout.tsx`.
3. Keep `wrangler.toml` the only place that attaches hostnames: once it lists any, every release makes its
   list the complete set for this Worker, so a hostname attached only in the dashboard would be detached by
   the next release.

## 4. Apex

The deploy token has no ruleset permission; do this in the dashboard: ziyixi.science → Rules → Redirect
Rules → Create rule (or the "Redirect from root to WWW" template):

- When incoming requests match: Hostname equals `ziyixi.science`
- Then: URL redirect, Dynamic, expression `concat("https://www.ziyixi.science", http.request.uri.path)`,
  status code **308**, **Preserve query string** on.

Leave the apex A record as it is (proxied; the rule answers at the edge before any origin). Later you may
change it to a proxied `AAAA 100::` so no request can reach Vercel. Check:
`curl -sI 'https://ziyixi.science/blog?x=1'` → `308`, `location: https://www.ziyixi.science/blog?x=1`.

## 5. Cleanup (after one to two weeks)

- **Vercel**: export Web Analytics history if wanted (collection had already stopped); remove the domains
  from the project `ziyixi-science`; delete the project; revoke `VERCEL_TOKEN` and the automation-bypass
  secret.
- **ziyixi/ziyixi.science**: delete its `Production` environment secrets (`VERCEL_*`, `NOTION_*`), then
  archive the repository (its Deployments stay readable; the bootstrap no longer needs them). If the
  dispatch token still lists ziyixi.science, remove it.
- **`.env.local`** (laptop): drop `VERCEL_TOKEN` and `VERCEL_AUTOMATION_BYPASS_SECRET`.
- Optionally drop the preview hostname from `wrangler.toml`.

## Rollback

| Where you are                | Rollback                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steps 1–2                    | Nothing public changed. Remove the preview line if wanted.                                                                                                                                                                                                                                                                |
| After step 3, a bad release  | It rolls itself back; or [release.md](release.md#rollback-by-hand).                                                                                                                                                                                                                                                       |
| After step 3, back to Vercel | Dashboard → Workers → ziyixi-website → Settings → Domains & Routes → remove `www.ziyixi.science`; DNS → add CNAME `www` → `cname.vercel-dns.com`, **proxied**. Then at once remove the `www` line from `wrangler.toml` and push, or the next release attaches `www` again. Vercel serves the content of its last release. |
| After step 4                 | Delete the Redirect Rule: Vercel's own apex 308 answers again (the A record was not changed).                                                                                                                                                                                                                             |
