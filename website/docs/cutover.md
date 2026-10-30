# Hosting history

The site moved from Vercel to Cloudflare Static Assets in September 2026. The separate apex-redirect Worker is
retired. Both current hostnames are Custom Domains of the assets-only website Worker; `www` is canonical and the
apex serves the same pages. [Architecture](architecture.md#hostnames) records the routing constraints.

Current bootstrap, publication and recovery use [Website release](release.md#manual-operations). Begin a first
publication with that workflow's `bootstrap` operation and its explicit confirmation; the old Vercel cutover steps
do not apply. Imported website commits remain discoverable through the [commit map](history-map.md).
