# Deployment probes

Shared, read-only checks called by each application's own production job. They do
not deploy, follow redirects, or print Cloudflare response bodies or credentials.

```sh
# From the app's worker directory; omit DB for an app without D1.
bash ../../tools/deploy-probes/production.sh lab ../wrangler.toml DB
# From the repository root; issuer and host come from the committed config.
bash tools/deploy-probes/access.sh / /api/v1/today
```

`production.sh` needs Bash, jq, the app's installed Wrangler, `GITHUB_SHA` and
`CLOUDFLARE_API_TOKEN`. It requires one deployed version at 100%, exactly one
matching BUILD_SHA, and no pending D1 migration when a binding is supplied.

`access.sh` needs Bash, curl, `ACCESS_ISSUER` and `PUBLIC_HOST`. Only the Access
login redirect for that exact host passes. Network failures and 5xx retry up to
ten times; anonymous 2xx, wrong redirects and other responses fail immediately.

The workflow integration and adverse-response tests run in Changes:

```sh
python3 -m unittest discover -s .github/scripts
```

App jobs retain their own tokens, gates, concurrency groups, and special checks
(FlowDay's PWA and Links' public redirects).
