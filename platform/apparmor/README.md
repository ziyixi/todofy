# Systemd observer policy

Only the credential-free `systemd-snapshot` init container uses
`personal-cloud-systemd-observer-v1`. The main observer retains its runtime default
profile. UID, capabilities, seccomp, read-only root and mounts remain unchanged.

The baseline comes from the exact dependency selected by
[K3s v1.37.1+k3s1](https://github.com/k3s-io/k3s/blob/v1.37.1%2Bk3s1/go.mod):
`github.com/k3s-io/containerd/v2 v2.3.4-k3s1`.
Its [AppArmor defaultTemplate](https://github.com/k3s-io/containerd/blob/v2.3.4-k3s1/contrib/apparmor/template.go)
has source SHA256 `f5bef9dd4d785a27aa00b421862c68de973f19bb5b36dd39f4a5d2dd35ac2683`.
This file selects its Ubuntu rootful variant: ABI 3.0, `tunables/global`,
`abstractions/base`, unconfined manager and no RootlessKit. The profile remains
confined; the `unconfined` signal peer refers to the host process.
Apache-2.0 attribution is retained and [LICENSE](LICENSE) is included.

The only added permissions are system-bus sends of `Hello`,
PolicyKit `CheckAuthorization`, systemd `GetUnit`, and `Properties.Get` on four
fixed unit paths. There are no receive, bind or eavesdrop grants. Requested replies
are implicit under the [D-Bus daemon's AppArmor rules](https://dbus.freedesktop.org/doc/dbus-daemon.1.html#AppArmor).

AppArmor checks interface, member and object path, **not message arguments**.
The kernel policy therefore permits reading any property on these four objects,
and `GetUnit` accepts any unit-name argument. The application selects only
`LoadState` and `ActiveState` for its four aliases. It still checks noninteractive
Polkit denial of management actions and reports `unknown` if it cannot establish
the expected boundary. No mutation is attempted.

Ubuntu 24.04 must already provide enabled AppArmor, the standard
`apparmor.service`, `/usr/sbin/apparmor_parser`, `abi/3.0`, `tunables/global`,
and `abstractions/base`. No Python package, daemon, host account or additional
privilege is installed. Initial VPS bootstrap preflights and loads this same
profile before applying the runtime. Its root-owned file in `/etc/apparmor.d/`
is loaded again by the existing OS service after reboot.

The controlled profile-only installer accepts only the compiled policy checksum, validates ownership and paths, and checks enforce mode. A matching retry reuses managed bytes; foreign state is refused. Host policy updates require separate owner authorization before a manifest can reference the profile.

CI uses the Ubuntu runner's real parser with `--skip-kernel-load --skip-cache`.
Absence of the parser fails the check. Synthetic installer tests do not prove
host loading, D-Bus access or Fleet receipts. Acceptance additionally needs a
natural observer run, matching image identity, successful snapshot read, safe
Polkit result and all four system-daemon states in Fleet/Home.
