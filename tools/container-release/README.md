# Tested service images

`image.py` is CI tooling, never part of an application bundle. It saves and publishes the Newsletter, Platform and Codex gateway
images (`--service`). The independent engine image is `ghcr.io/ziyixi/todofy-newsletter`; the monorepo name does not
change the engine's image name.

Each credential-free image check builds and tests one image ID, then saves its Docker archive,
source SHA, image ID and SHA256. The gated main publisher loads that archive and checks all
three identities before tagging and pushing it. There is no second build in the publisher.

`build.py` builds each service's Linux amd64 OCI archive with the fixed Bazel toolchain, loads it and checks its source
revision before the existing probes run. The SHA must be nonzero and match the checkout's HEAD. It is embedded in the
final identity layer, so application, dependency and runtime layers retain their own cache keys. The check actions keep
their existing source audits, offline probes and tested artifact format.

The application root targets `//newsletter`, `//platform` and `//codex-gateway` produce those final archives. Each root's
`:check` aggregates its Bazel tests and `:config` exposes static deployment inputs. Actions owns publication and deployment.

When main reuses an exact-SHA green branch run, change detection also requires its unexpired
one-day image artifact. Missing/expired artifacts cause fresh checks and a fresh tested build
on main. Artifacts themselves are not deployment or backup records; production uses a GHCR
digest. Publication does not change the VPS, trigger collection, or send a newsletter.

The monorepo Actions creates its own package; the gated publisher alone has Packages Write. No Cloudflare credential,
VPS SSH key, model login or private content belongs in this workflow.

Artifacts are short-lived promotion material. Standard public-repository Actions usage and GHCR container
storage are currently free under [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
and [GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages).
