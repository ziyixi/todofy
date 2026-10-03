# Host boundary / 宿主边界

Only standard K3s and the dedicated `cloudflared-platform.service` run as new host
systemd services. Bootstrap renders their public units. It leaves the existing
SSH Tunnel and other host units untouched. Daemon and observer both run from the
same versioned platform image inside K3s; no host observer executable, Python
runtime installation, account, long-lived Kubernetes token or timer is created.

`platform-observer` is a five-minute CronJob with Forbid concurrency. Its main process keeps UID/GID 10001,
no Linux capabilities, no privilege escalation, a read-only root filesystem and an
independent persistent PVC for its sequence and frozen pending report. It has no
hostPID, hostNetwork, Docker socket, private systemd socket or host root mount.
It uses an explicitly projected rotating read-only ServiceAccount and its own receipt HMAC identity.
Automatic token mounting is disabled for the pod; only the main container receives that projection.

The main container's only host metadata mount is `/proc/meminfo` (File, read-only).
A standard init container from the same immutable image uses the host's existing UID65534 (`nobody`)
and GID10001 to read `/run/dbus/system_bus_socket` (Socket, read-only). D-Bus authenticates the Unix
identity on the host; a UID present only inside an image is insufficient for the host's user policy.
The probe receives only that socket and a temporary emptyDir, with no ServiceAccount token,
monitoring credentials or persistent volume. It writes a bounded `fleet.telemetry.v1.SystemDaemonSnapshot`
using the shared codec; the main container mounts it read-only and rejects malformed snapshots,
snapshots older than 120 seconds or timestamps more than five seconds in the future. The observer's
durable sequence and pending receipt remain unchanged. An unreadable probe writes unknown states.

Disk usage comes from statvfs on the main container's own PVC, sharing its host filesystem;
on a separate ZFS dataset this describes that dataset, not the whole storage pool. No process
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
