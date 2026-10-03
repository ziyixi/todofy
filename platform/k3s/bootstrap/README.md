# Initial VPS resources / 初始 VPS 资源

This directory is **bootstrap-only**. The privileged installer renders `config/cloud.toml`'s
`vps.namespace` and `vps.state_root`, creates and checks the host directories, then applies this
resource set once. Normal GitHub releases use the authenticated RuntimeService API; they never
receive Kubernetes credentials or apply these RBAC, volume or Secret resources.

| Identity | Scope | Permissions |
| --- | --- | --- |
| `platform-controller` | configured namespace | Deployments, CronJobs, Services and ConfigMaps get/list/create/patch/update; Pods get/list |
| `platform-observer` | configured namespace | Deployments and Pods get/list |
| `platform-observer` | cluster | Nodes get/list only |

Neither identity can read Secrets, create tokens, exec into Pods, change RBAC, delete resources,
or edit other namespaces. Pod observations let the daemon verify actual imageIDs; declared targets
alone do not prove a release. Namespace-scoped workload writes are powerful: the daemon's shared
proto admission validates the configured resource names, images and safe Pod specification before
using its controller identity. RBAC does not independently restrict the names of objects created.
[Kubernetes RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/) documents this boundary.

Daemon and observer each use their pod's rotating projected ServiceAccount token.
No long-lived ServiceAccount Secret or host Kubernetes token is provisioned. The
observer's separate HMAC credential only submits bounded metadata to Fleet; it has
no deployment credential. See [ServiceAccount lifecycle](https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/).

Five static PV/PVC pairs prebind the exact existing single-node directories:

| Claim | Default host path | Use |
| --- | --- | --- |
| `observer-state` | `/srv/todofy/observer` | observer sequence and frozen pending receipt |
| `platform-state` | `/srv/todofy/platform` | daemon SQLite release ledger |
| `newsletter-data` | `/srv/todofy/newsletter/data` | Newsletter's existing persistent state |
| `newsletter-auth` | `/srv/todofy/newsletter/auth` | Newsletter's existing provider login state |
| `newsletter-config` | `/srv/todofy/newsletter/config` | public content configuration; writable by config sync, read-only in engine |

`hostPath.type: Directory` makes a missing directory fail instead of silently creating an empty
replacement. The installer prepares paths and preserves existing data before Pods start. Runtime
files belong to UID/GID 10001; separate PVC mounts keep observer state apart from the daemon ledger.
The observer runs as a non-root CronJob from the platform image; its bounded host metadata
mounts and system-bus policy boundary are described in [host boundary](../../systemd/README.md). `Retain`, explicit `volumeName` and an
empty storage class prevent automatic volume provisioning or removal. The nominal storage requests
are scheduling metadata, **not filesystem quotas or backups**. These local volumes suit one node;
new VPS recovery still needs restored state and fresh provider authentication where required.
[Kubernetes persistent volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/) describe the lifecycle.

Namespace, binding subjects and PV claim namespaces must all use the rendered configured namespace.
Host persistent paths must all use the rendered state root. Secrets stay in
regular private local input files, never these manifests. Applying a bootstrap directory is not a
verified release; the final GitHub operation must reach `ready` with actual provenance and admission
restored before being reported successful.
