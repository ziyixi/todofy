# Home configuration and operations

Runtime behavior is in [design.md](design.md); configured quota references are in [limits.md](limits.md).
Production acceptance is recorded separately in root HANDOFF and [dated verification](verification.md).

## 1. Sources and resources

`dashboard/wrangler.toml` is the production source: Worker `home`, its Custom Domain, static assets, SQLite
HomeState binding, named service bindings and half-hour cron. Production has no `[env.*]`, `keep_vars` or local
bypass. Home owns no D1 database or R2 bucket. Its state and receipts live in HomeState, instance `home-v1`.

Application bindings and public hosts must agree with each producer's manifest/configuration. The registry,
generated account inventory and drift-desired data are validated in the check graph. Resource changes use their
normal Wrangler/IaC publication path and exact ownership review; a failed observation is not repaired by creating
an empty replacement resource. See [resource registration](../../docs/dashboard-state.md#资源登记) and
[infrastructure](../../infra/README.md).

## 2. Authentication and publication inputs

Access protects the entire owner host. The Worker independently verifies the assertion with edge-auth, including
owner/alias matching, then checks exact Origin, the bounded custom header and JSON media type before mutation
bodies. `/health` bypasses only the Worker's check, not the host's Access application. No broad redirect or bypass
may substitute for that boundary.

Static issuer, audience, account, host and schedule values belong in Wrangler. The existing deployment wrapper
validates the operational canary switch, build identity and private inputs without printing values. Owner identity
and analytics access remain secrets; production credentials stay in publication jobs, outside build/test jobs.
The read-only analytics credential is sent only to the fixed Cloudflare endpoints used by usage, inventory and
drift observation. It is never a write credential or a page response.

`DASHBOARD_CANARY_ENABLED` must be explicitly valid for publication. Changing deployment inputs takes effect only
with that application's authorized release; already-running isolates do not read GitHub settings dynamically.
Shared owner-identity changes require checking the actual consumers through their release dependencies.

Private services can attach optional `PRIVATE_CATALOG` JSON without publishing their names or configuration in
this repository. The same attachment is supplied to Home and the production reconciliation job. Its shape is
`{registry: {entries, workers, resources}, desired: {version, zones, workers}}`, using the existing registry and
drift-desired fields. Empty/unset keeps the public catalog. A nonempty invalid attachment fails with
`PRIVATE_CATALOG_INVALID`; it cannot replace public identities or hide unregistered resources.

Supplemental entries use `public_http` or `link_only`, owner-zone HTTPS links, and the existing groups. A public
probe of an Access-protected service needs its own declared bypass path, a 2xx expectation and a content type.
It makes one fetch per due interval and reads no body. Supplemental entries add no Ops binding, control or flow.
Worker configuration and exact storage identities join the same owner views and read-only reconciliation; the
existing outbound ceilings still apply. Source/build identity remains the private release's responsibility.

## 3. Local development

```sh
pnpm install --frozen-lockfile
cp dashboard/.dev.vars.example dashboard/.dev.vars
pnpm --dir dashboard/worker dev
```

The example contains synthetic local values. Wrangler reads the ignored `.dev.vars` beside its configuration.
The dev script prepares the Bazel UI bundle and pins its loopback origin; use local bindings, never `--remote`.
Loopback bypass requires the configured local host rule and no `cf-ray`; `DEV_NOW` affects only those bypassed
requests, never cron or production. Missing local producer bindings and analytics data remain explicit unknowns.

Complete offline flows use the existing Miniflare runtime harness, injected clocks, contract fixtures and outbound
fakes. They need no production credential or personal content. Do not infer live Access, account or business success
from those synthetic checks.

## 4. Checks and release

```sh
bazel test //dashboard:check
bazel build //dashboard
```

The root target builds the canonical release archive; `:check` covers Worker/UI/types/lint/tooling/runtime/CPU and
budget checks. Main publication consumes the tested archive through the existing wrapper, hostname guard,
production gate and reconcile. A branch build does not publish. Current release/order/recovery procedures are in
[CI/CD](../../docs/ci-cd.md); this page does not maintain a parallel deployment command sequence.

## 5. Operations

- Guard controls name one capable service. Desired override and received state are separate. Shed expires; ingest,
  processing, delivery/retries and integrity work keep each producer's contract. [Current controls](../../docs/dashboard-state.md#按服务延后后台工作).
- A disabled canary starts nothing new, while already-queued delivery/consumer work continues to a verdict. It
  verifies only the delivery/summary path, not Email Routing or parsing. [Canary](design.md#54-delivery-and-processing-canary).
- Digest retries keep one frozen TaskInbox request. Reminder dismissal affects Home's next report, not producer
  health or business retries. [Digest](design.md#55-digest), [reminder control](design.md#8-reminder-control).
- Cloudflare refresh may advance a multi-tick drift check. Compare completion time, progress and actual differences;
  a usage refresh alone does not prove a new drift result. [Drift](design.md#7-configuration-drift).

Rollback, stopping a schedule or retiring the service follows the repository's authorized configuration/release
process. Existing durable canary, digest and website request identities must survive; reverting source does not
undo an already-published resource or an external side effect. Remove no live object merely to make a check green.
