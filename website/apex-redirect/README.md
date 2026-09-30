# Apex redirect: ziyixi.science → www

The Worker `ziyixi-apex-redirect` (TypeScript, no dependencies, no bindings) answers every request to the
apex `ziyixi.science` with a **308** to `https://www.ziyixi.science` plus the same path and query, and
`Strict-Transport-Security: max-age=63072000`. It replaces Vercel's apex → www 308 (same status, same
Location, same HSTS value), so the Vercel project can be deleted without breaking the apex.

- **Every method** gets the same answer (`GET`, `HEAD`, `POST`, …), with no body and no other header.
- **Path and query as sent**: percent-encoding is kept, raw characters are encoded once, the fragment
  (never sent by browsers) and any credentials are dropped.
- **No open redirect**: the target origin is the constant in [`src/redirect.ts`](src/redirect.ts);
  nothing in the request (Host, `X-Forwarded-Host`, a `//host` path, the query) can change it.
- **HSTS** without `includeSubDomains` or `preload`: other subdomains are separate apps.

## How it is attached

[`wrangler.toml`](wrangler.toml) lists one zone **Workers Route**,
`{ pattern = "ziyixi.science/*", zone_name = "ziyixi.science" }`, on the existing proxied apex record.
A route changes no DNS: the apex's A record and its iCloud MX, SPF/`apple-domain` TXT, `_dmarc` and DKIM
records are never touched. The pattern matches the apex host only (a leading `*` would also match every
subdomain). `workers_dev` and `preview_urls` are off.

It lives in `website/apex-redirect/` because it belongs to the website app: it shares the website's
`package.json` (wrangler, vitest, TypeScript, ESLint, Prettier) and its tests
([`test/redirect.test.ts`](test/redirect.test.ts)) run in `Website checks`, but it has its own
`wrangler.toml` and its own deploy job, **Website apex deploy** in `.github/workflows/ci.yml`: on `main`,
after the CI gate, a change under `website/apex-redirect/` dry-runs, deploys (`wrangler deploy` creates the
route) and then requires the apex to answer with this Worker's 308 (exact Location, HSTS, no Vercel
header). A change there neither releases the site nor redeploys the relay.

Locally, from `website/`:

```sh
pnpm exec vitest run apex-redirect
pnpm exec wrangler deploy --dry-run --config apex-redirect/wrangler.toml
pnpm exec wrangler dev --config apex-redirect/wrangler.toml --port 8791   # curl -sI http://127.0.0.1:8791/x?y=1
```

## Cost

Workers Free: each apex request is one Worker request (100,000 a day for the account) and well under
1 ms CPU (one URL parse, no subrequest, no storage). Links and search results point at www, so the
apex sees little traffic.

## Rollback

Delete the route: Cloudflare dashboard → ziyixi.science → Workers Routes → `ziyixi.science/*` → Delete
(or Workers → ziyixi-apex-redirect → Settings → Domains & Routes). The apex then reaches its origin
record again: Vercel's own 308 while the Vercel project still has the domain, and an error after Vercel
is deleted, so after the Vercel deletion replace the Worker rather than remove it. Removing the `routes`
line from `wrangler.toml` alone does not detach the route (wrangler leaves routes it no longer lists in
place when the list is empty); delete it in the dashboard.
