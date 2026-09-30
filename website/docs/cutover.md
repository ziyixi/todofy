# Cutover runbook: Vercel → Cloudflare

For the lead. Every step keeps `www.ziyixi.science` answering; each has a rollback. Vercel is not touched
until the cleanup at the end, so it stays the fallback (frozen at its last release: after step 1 new Notion
content goes only to the Worker). Steps 3 and 4 use zone Workers Routes on the existing proxied records, so
the cutover changes no DNS record at all.

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

1. Merge to `main`. CI runs `Website checks`, then `Website deploy` dispatches a Website release (its gate
   finds no release record and stops green with the notice "dispatch bootstrap") and `Website relay deploy` (the relay now targets
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
   `cache-control: no-store, max-age=0`, `strict-transport-security: max-age=63072000` and
   `access-control-allow-origin: *`; `curl -sI https://website-preview.ziyixi.science/blog/` is a `308` to
   `/blog`. Click 刷新状态
   and 发布网站 once; both runs appear under Actions → Website release.

Rollback: remove the line and push (the next release detaches the hostname).

## 3. www (zone route)

**Why a route, not a Custom Domain.** The first attempt listed `{ pattern = "www.ziyixi.science",
custom_domain = true }`. That release failed at `wrangler triggers deploy` because `www` already has a
proxied CNAME to `cname.vercel-dns.com` ("already has externally managed DNS records"), and `CF_API_TOKEN`
may neither edit DNS nor rulesets (both 403, checked 2026-09-30). The release rolled the version back and
`www` kept serving Vercel. The token may create and delete zone **Workers Routes** (checked with a probe
route, then deleted), and a route changes no DNS: it runs the Worker in front of the existing proxied
record, so the CNAME stays and Vercel is simply no longer reached.

1. `website/wrangler.toml` lists the preview Custom Domain and the `www` route:

   ```toml
   routes = [
     { pattern = "website-preview.ziyixi.science", custom_domain = true },
     { pattern = "www.ziyixi.science/*", zone_name = "ziyixi.science" },
   ]
   ```

   The push to `main` releases: `wrangler triggers deploy` keeps the preview Custom Domain and creates the
   route, and from then on the release verifies on `https://www.ziyixi.science` (identity three times in a
   row, then the whole route contract) and writes the Notion feedback against it. If the route cannot be
   created, the deploy step fails, the release rolls the version back and `www` keeps serving Vercel.

2. Check at once: `curl -sI https://www.ziyixi.science/` has no `x-vercel-id`;
   `curl -s https://www.ziyixi.science/build-info.json` shows the Worker's `contentHash` (the same as the
   preview host); `robots.txt`, `build-info.json` and `publication-state.json` are not rewritten by the zone
   cache (`cache-control` as in step 2); HSTS and `access-control-allow-origin: *` present; `/blog/` → 308
   `/blog`; `/nope` → 404; `/feed.xml` is `application/rss+xml`. The live site has no analytics beacon
   today and the new one has none either; adding analytics is a separate decision, not a cutover step.
3. Keep `wrangler.toml` the only place that attaches hostnames to `ziyixi-website`: every release makes
   its Custom Domains the complete set, and its zone routes the complete set whenever it lists at least one.

**Later, optional: www as a Custom Domain.** Only the owner can do it (the token cannot replace DNS):
Workers → ziyixi-website → Settings → Domains & Routes → Add → Custom Domain `www.ziyixi.science`, accept
replacing the existing CNAME; then change the `www` line in `wrangler.toml` to
`{ pattern = "www.ziyixi.science", custom_domain = true }` and push. The route is not needed after that;
delete it in the dashboard (Workers Routes), because a release that lists no zone route leaves existing
routes in place. Nothing requires this move: the route serves the same Worker.

## 4. Apex (Worker ziyixi-apex-redirect)

The apex keeps its proxied A `76.76.21.21` and its MX, TXT and DKIM records. A second small Worker,
[`ziyixi-apex-redirect`](../apex-redirect/README.md) (`website/apex-redirect/`), is attached by the zone
route `ziyixi.science/*` and answers every request with a **308** to `https://www.ziyixi.science` plus the
same path and query, with `strict-transport-security: max-age=63072000` (what Vercel's apex 308 sent; no
includeSubDomains or preload). It replaces Vercel's apex redirect exactly and needs no ruleset permission.
The job **Website apex deploy** deploys it (on `main`, after the CI gate, for a change under
`website/apex-redirect/`, or a dispatch with `website`/`all`) and then requires the apex to answer with the
Worker's 308: exact Location, HSTS, and no `x-vercel-*` header.

Check by hand: `curl -sI 'https://ziyixi.science/blog?x=1'` → `308`,
`location: https://www.ziyixi.science/blog?x=1`, `strict-transport-security: max-age=63072000`, no
`x-vercel-id`.

Once `www` and the apex are both served by Workers, **deleting Vercel is safe**: no request reaches it.

## 5. Cleanup (whenever the owner wants; nothing depends on Vercel any more)

- **Vercel**: export Web Analytics history if wanted (collection had already stopped); remove the domains
  from the project `ziyixi-science`; delete the project; revoke `VERCEL_TOKEN` and the automation-bypass
  secret. After that the `www` CNAME and the apex A record point at nothing that answers, but they stay:
  the Workers answer in front of them, and a proxied record is what a route needs. Optionally the owner
  may later change the apex A to a proxied `AAAA 100::` and the `www` CNAME likewise; never touch the MX,
  TXT or DKIM records.
- **ziyixi/ziyixi.science**: delete its `Production` environment secrets (`VERCEL_*`, `NOTION_*`), then
  archive the repository (its Deployments stay readable; the bootstrap no longer needs them). If the
  dispatch token still lists ziyixi.science, remove it.
- **`.env.local`** (laptop): drop `VERCEL_TOKEN` and `VERCEL_AUTOMATION_BYPASS_SECRET`.
- Optionally drop the preview hostname from `wrangler.toml`.

## Rollback

| Where you are                | Rollback                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steps 1–2                    | Nothing public changed. Remove the preview line if wanted.                                                                                                                                                                                                                                                                                                                                                          |
| After step 3, a bad release  | It rolls itself back; or [release.md](release.md#rollback-by-hand).                                                                                                                                                                                                                                                                                                                                                 |
| After step 3, back to Vercel | Only while the Vercel project still exists. Dashboard → ziyixi.science → Workers Routes → delete `www.ziyixi.science/*` (the CNAME was never changed, so Vercel answers at once). Then remove the `www` line from `website/wrangler.toml` and push, or the next release creates the route again (removing the line alone does not delete the route: with no zone route listed, wrangler leaves routes as they are). |
| After step 4                 | Dashboard → ziyixi.science → Workers Routes → delete `ziyixi.science/*`: Vercel's own apex 308 answers again while the Vercel project exists (the A record was not changed). After Vercel is deleted there is no fallback; fix and redeploy the Worker instead.                                                                                                                                                     |
