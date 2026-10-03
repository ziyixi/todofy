# One-time VPS bootstrap

Edit public identity in `config/cloud.toml`, configure credentials, and use the same
verified images on a new VPS. Application source does not change. The complete
Cloudflare/GitHub rebuild sequence is in [`docs/rebuild.md`](../../docs/rebuild.md).

The installer is a one-time root setup for standard K3s, retained storage, scoped
RBAC and a dedicated Cloudflare connector. Normal releases use the platform API
from GitHub Actions. Both the daemon and observer run **only as container images
in K3s**, without a host Python service, executable, extra user or timer.

## Prepare locally

Use the development Python environment with PyYAML and a local `kubectl` for
**offline** Kustomize rendering. Select both immutable digests from the successful
Actions run for the exact commit; this tool rejects a mutable tag or foreign owner.

```sh
platform/.venv/bin/python tools/vps-bootstrap/prepare.py \
  --sha <verified-40-character-source-sha> \
  --newsletter-image ghcr.io/<owner>/todofy-newsletter@sha256:<digest> \
  --platform-image ghcr.io/<owner>/todofy-platform@sha256:<digest> \
  --output <new-public-bundle-directory>
```

The public bundle contains rendered resources, pinned versions, allowed private
setting names, standard K3s/Tunnel units and stdlib installer modules. Each file
has a checksum; these establish bundle consistency, not an independent signature.
Initial Newsletter admission holds `release-<source_sha>` and its daily CronJob
is suspended. The observer CronJob remains active every five minutes, with Forbid
concurrency and its own persistent sequence/pending-receipt PVC.
The first API release must use that same bootstrap source SHA. Keep normal VPS
deployment disabled and avoid advancing the first-release commit until it is verified;
a different SHA cannot silently replace the existing held admission operation.

## Private input

Create a JSON file **on the VPS**, owned by its creator with mode 600. Never commit
it or send tokens through chat. Exact shape:

```json
{
  "schema_version": 1,
  "newsletter_env": {
    "NEWSLETTER_EDITOR_TOKEN": "<preserve existing>",
    "NEWSLETTER_SEND_TOKEN": "<preserve existing>",
    "NEWSLETTER_MONITOR_TOKEN": "<new independent readonly token>"
  },
  "trigger_env": {
    "NEWSLETTER_EDITOR_TOKEN": "<same as engine>",
    "NEWSLETTER_SEND_TOKEN": "<same as engine>",
    "NEWSLETTER_TIME_ZONE": "America/Los_Angeles"
  },
  "platform_env": {"PLATFORM_DEPLOY_TOKEN": "<dedicated release API token>"},
  "fleet_key": "<64 hexadecimal characters, independent receipt HMAC>",
  "connector_token": "<dedicated runtime Tunnel connector token>",
  "old_paths": {
    "data": "<absolute stopped-runtime data directory>",
    "auth": "<absolute provider login directory>",
    "config": "<absolute content configuration directory>"
  }
}
```

Engine settings must appear in generated `allowedkeys.json`. Trigger accepts only
shared editor/send tokens and optional time zone; platform accepts only its deploy
token. Preserve existing editor/send values; editor requires 24–512 characters,
send/monitor/platform require 32–512, and tokens cannot contain whitespace.
Editor and send must differ, monitor must differ from editor/send/platform, and
platform must differ from send. These checks run before server changes.
The renderer controls persistent paths, release/admission IDs, and service URLs.
Private input cannot override those paths or inject PATH/HOME/PYTHONPATH,
OPENAI_API_KEY or loader variables. A fresh VPS may use `old_paths: {}`; Newsletter's
same-image init container seeds the packaged configuration only into a completely
empty configuration volume. Existing active configuration is validated without
rewriting it; nonempty missing or corrupt state stops startup for review. Complete
the application's normal provider setup separately. Existing source directories must be
regular, symlink-free, stopped, and outside SSH/GPG folders.

## Install

Supported initial host: Ubuntu 24.04 Linux amd64 with its existing Python 3 stdlib,
systemd, iptables/ip6tables restore commands, and an already installed cloudflared
at `/usr/bin/cloudflared` or `/usr/local/bin/cloudflared`. No Python packages are
installed on the VPS. Meet [K3s requirements](https://docs.k3s.io/installation/requirements)
and provide outbound HTTPS for the pinned K3s binary and verified public images.

```sh
sudo python3 <bundle>/installer/install.py \
  --bundle <bundle> --credentials <owner-only-credentials.json>
```

The installer checks inputs before writes, copies opaque state without removing
its source, creates root-reviewed host directories owned by UID 10001, installs
the pinned K3s binary, and applies foundation/Secrets/held runtime. All apply uses
server-side apply with `field-manager=personal-cloud`, matching normal releases,
without force takeover. Its own `PCLOUD-K3S` INPUT chain allows Kubernetes ports
6443/10250 and VXLAN 8472 only on loopback or local cni0 Pod CIDR traffic. It does
not flush other chains or change SSH. Its rules reload before K3s starts.

The only new host connector is `cloudflared-platform.service`, with its own private
token file. Its standard readiness notification must confirm a registered connection
before bootstrap can write a completion marker. Existing SSH/cloudflared services are untouched. After preserving the stopped legacy state,
the installer disables and stops existing docker.socket/docker.service before applying
its firewall rules. This authorized retirement does not uninstall Docker or delete
images, Compose files, volumes or the preserved source directories. Daemon and
observer use rotating projected Kubernetes identities. No long-lived host token
or cluster credential reaches GitHub/Fleet. Observer's independent HMAC/transport
Secret does not authorize deployment.

`complete_held` means bootstrap finished while business admission is held. It does
not claim delivery, release activation, or an accepted Fleet report. Use the matching
Actions operation to activate the release, check actual SHA/digest/UUID, healthy
worker and accepting admission, verify Fleet's fresh report. Compose services are already retired by this one-time
bootstrap; they are not automatically restarted as a fallback. System-bus permissions also require the non-mutating
polkit check described in [the observer boundary](../../platform/systemd/README.md).

## Failures and retries

After the connector/services step succeeds, the installer atomically writes a
root-owned completion marker for that exact public bundle. Running that same bundle
again returns `already_initialized` and makes no changes, without claiming admission
is still held. A different bundle is refused: normal updates, including after
release activation, always use the daemon API through Actions. The completion marker
is never written for a failed install; retry that same incomplete bundle to continue.

Foreign managed units, K3s binaries,
configurations, firewall rules, credentials or nonempty state destinations are
refused rather than merged. A crash during a copy may leave a staging directory or
new destination before its final marker; retry then fails with a fixed review code.
Review that new copy against the preserved original before recovery. Unknown business
outcomes remain held; no installer step forces them complete, resumes delivery,
deletes old state or automatically restarts Compose. Credential rotation is a separate reviewed step.

```sh
platform/.venv/bin/python -m unittest discover -s tools/vps-bootstrap/tests -v
platform/.venv/bin/python -m unittest discover -s platform/tests/bootstrap -v
kubectl kustomize platform/k3s/bootstrap
```

These are synthetic/offline checks, not proof of live firewall, Access/Tunnel,
provider authentication, production recovery or delivery.
