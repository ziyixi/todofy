# cf-guard: deploy-time hostname guard

`wrangler deploy` and `wrangler triggers deploy` apply the `routes` of a `wrangler.toml` per category, and a
non-empty category replaces what is live (verified in wrangler 4.142's `publish-routes.ts`):

- **Custom Domains** (`custom_domain = true`): `POST .../domains/changeset?replace_state=true`, then
  `PUT .../workers/scripts/<name>/domains/records` with `override_scope: true`. In CI (no TTY) wrangler also
  sets `override_existing_origin` and `override_existing_dns_record`, so a listed hostname is taken from
  another Worker and an existing DNS record for it is overwritten without a prompt.
- **Zone routes**: `PUT .../workers/scripts/<name>/routes`, which deletes the script's other routes in every
  zone.
- An **empty** category is left alone.

So a stale `wrangler.toml` detaches live hostnames on the next deploy, and a version rollback does not bring
them back. Every deploy job runs this guard on its configs before the first production change:

```sh
node tools/cf-guard/cf-guard.mjs --config mail-hero/wrangler.toml
node tools/cf-guard/cf-guard.mjs --config todofy/wrangler.toml --config todofy/gateway/wrangler.toml
```

For each config and each non-empty category it reads the live state and fails (exit 1) when:

| Case | Example |
| --- | --- |
| removed | a Custom Domain or zone route is live on this Worker but not listed |
| conflict | a listed hostname is another Worker's Custom Domain; a listed zone route belongs to another script; a hostname new to this Worker already has an `A`/`AAAA`/`CNAME` record, or its DNS records cannot be read |

Exit 2 is a usage or API error (missing token, HTTP error). A config without routes needs no token and sends
no request.

**Intentional changes.** Set the exact hostnames or patterns (space- or comma-separated) on the job's guard
step, in the same commit that edits `wrangler.toml`, and clear them again afterwards:

- `CF_GUARD_ALLOW_REMOVE`: removals to allow. The allow list is committed and printed, so it publishes the
  name: to drop a hostname that is not in the repository, detach it by hand in the Cloudflare dashboard
  instead (the next deploy then passes without naming it).
- `CF_GUARD_ALLOW_CONFLICT`: takeovers to allow (after checking the record or the other Worker by hand).

**Read-only, public-log safe.** Only `GET` requests: `/accounts/{A}/workers/domains` (filtered by `service`
and by `hostname`), and only when needed `/zones` (zone lookup), `/zones/{Z}/dns_records?name=` (for a new
hostname) and `/zones/{Z}/workers/routes`. It does not call the changeset endpoint: it is a `POST` that
Cloudflare does not document, so this guard does not assume it is side-effect free. It prints Worker names,
the hostnames and route patterns of the checked config and of the allow lists (both committed), counts and
PASS/FAIL, never a response body, an id, the token or another Worker's name; an API error prints only the
HTTP status and Cloudflare's error codes. A live hostname or route of the Worker that is in neither the config
nor an allow list is only counted (`REMOVE  1 live Custom Domain(s) not in wrangler.toml`): the deploy logs of
this public repository must not name a hostname attached outside the repository, or show that it drifted. To
see which one, use the dashboard's 配置漂移 panel or the Worker's Domains & Routes in the Cloudflare
dashboard. The token is the deploy job's
own (`Workers Scripts` covers the domain list; the zone reads need `Zone`/`DNS`/`Workers Routes` read, which a
config with zone routes needs for its deploy anyway).

**No dependency.** Node 20+ only, so it runs before any install; `toml.mjs` reads TOML 1.0 and its test
compares it with Python's `tomllib` on every committed wrangler config. Tests use a synthetic API:

```sh
node --test tools/cf-guard/test/*.test.mjs
```
