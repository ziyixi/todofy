# Host boundary / 宿主边界

Only standard K3s and the dedicated `cloudflared-platform.service` run as new host
systemd services. The one-shot `personal-cloud-node-address.service` only creates K3s's
[fixed node address](../../tools/vps-bootstrap/README.md#fixed-node-address-and-dns) before K3s starts
and leaves no process. Bootstrap renders their public units. It leaves the existing
SSH Tunnel and other host units untouched. Daemon and observer both run from the
same versioned platform image inside K3s; no host observer executable, Python
runtime installation, account, long-lived Kubernetes token or timer is created.

`platform-observer` is a five-minute CronJob with Forbid concurrency. Its main process keeps UID/GID 10001,
no Linux capabilities, no privilege escalation, a read-only root filesystem and an
independent persistent PVC for its sequence and frozen pending report. It has no
hostPID, hostNetwork, Docker socket, private systemd socket or host root mount.
It uses an explicitly projected rotating read-only ServiceAccount and its own receipt HMAC identity.
Automatic token mounting is disabled for the pod; only the main container receives that projection.

The main container's host metadata mounts are all read-only: `/proc/meminfo` and `/proc/1/net/dev`
(Files: PID 1's file is the host network namespace, while the Pod's own `/proc/net/dev` shows only the Pod's
interfaces), and the statvfs targets for the root and K3s filesystems, never read or listed: the public
`/usr/lib/os-release` File (a file has no subtree or nested mounts) and the `/var/lib/rancher/k3s` Directory
(K3s's agent and server state are root-only).
Kernel-wide `/proc/stat`, `/proc/loadavg`, `/proc/uptime` and the boot ID are the host's inside any Pod and need no mount.
A standard init container from the same immutable image uses the host's existing UID65534 (`nobody`)
and GID10001 to read `/run/dbus/system_bus_socket` (Socket, read-only). D-Bus authenticates the Unix
identity on the host; a UID present only inside an image is insufficient for the host's user policy.
The probe uses the dedicated [AppArmor profile](../apparmor/README.md), loaded once by
bootstrap. It preserves the pinned containerd baseline and permits only the fixed D-Bus
methods needed by this probe. AppArmor does not inspect method arguments; the application
selects the four unit aliases and two properties, and the Polkit guard remains mandatory.
The main observer retains RuntimeDefault. The probe receives only that socket and a temporary emptyDir, with no ServiceAccount token,
monitoring credentials or persistent volume. It writes a bounded `fleet.telemetry.v1.SystemDaemonSnapshot`
using the shared codec; the main container mounts it read-only and rejects malformed snapshots,
snapshots older than 120 seconds or timestamps more than five seconds in the future. The observer's
durable sequence and pending receipt remain unchanged. An unreadable probe writes unknown states.

Disk usage comes from statvfs on the main container's own PVC and the two directory mounts above;
on ZFS each describes its dataset (its used bytes plus the pool's free space), not the whole storage pool.
Only the summed byte counters of physical interfaces (`en*`, `eth*`, `wl*`, `ww*`) are sent, never their names.
Per-workload CPU and memory come from the cluster's metrics API (K3s's bundled metrics-server), read with a
namespaced `list` of `pods.metrics.k8s.io`; there is no node proxy, kubelet stats or node-metrics permission.
Without that grant or metrics-server the report simply has no workload usage. No process
environment, logs, mail, provider credentials or private application volumes are read.

Jeepney 0.9.0 is a mature [pure Python D-Bus client](https://pypi.org/project/jeepney/)
with [threading calls and bounded timeouts](https://jeepney.readthedocs.io/en/latest/api/threading.html).
The adapter uses fixed `GetUnit` and `Properties.Get` calls for LoadState/ActiveState
of k3s, cloudflared, ssh and the runtime connector. An unreadable bus/unit remains
unknown. `GetUnit` only observes loaded units, so `NoSuchUnit` also remains unknown;
it does not prove the unit file is absent. An explicit LoadState=not-found reports missing.

A read-only socket mount **does not make the D-Bus protocol read-only**. The actual
permission boundary is the non-root process identity and host systemd/polkit
policy. [systemd's official policy](https://github.com/systemd/systemd/blob/main/src/core/org.freedesktop.systemd1.policy.in)
requires authorization for management actions; deployments must not grant the probe's UID65534
those permissions. The probe first uses the mature
[polkit CheckAuthorization API](https://www.freedesktop.org/software/polkit/docs/latest/eggdbus-interface-org.freedesktop.PolicyKit1.Authority.html)
for its own system-bus-name subject, flags 0 (no interactive authorization), on
manage-units, manage-unit-files, set-environment and reload-daemon. A granted action
refuses reporting with a fixed safe error. A missing/unreadable policy service
leaves unit status unknown. It never tests permission by starting or stopping a unit. A granted
management action fails the init container, so no signed observation can silently claim a safe boundary.

Synthetic tests verify fixed methods, no interaction, unknown/missing handling and
a refused management grant. Live acceptance still must establish that host policy
actually denies those management actions and that metadata queries succeed; tests
and readonly mounts alone cannot prove it.

K3s or the host failing also stops this image observer. Fleet then expires the last
receipt to stale/missing and does not claim a current cause. Its Worker/UI remain
independently available on Cloudflare. This is the chosen minimal image-only
monitoring boundary rather than a second host supervisor.
