# VPS bootstrap bundle

This tool prepares the public, immutable input to the existing one-time installer. Normal releases use the daemon API through Actions. Configuration and recovery limits are documented in [rebuild](../../docs/rebuild.md).

<a id="prepare-locally"></a>

## Build the public bundle

From the repository root, use the exact tested source SHA and published image digests:

```sh
bazel build //platform:bootstrap_bundle \
  --embed_label=<verified-full-source-sha> \
  --define=TODOFY_NEWSLETTER_IMAGE=ghcr.io/<owner>/<repository>-newsletter@sha256:<digest> \
  --define=TODOFY_PLATFORM_IMAGE=ghcr.io/<owner>/<repository>-platform@sha256:<digest> \
  --define=TODOFY_CODEX_GATEWAY_IMAGE=ghcr.io/<owner>/<repository>-codex-gateway@sha256:<digest>
```

The gateway value may be empty for an existing paired release. Both paired images remain required. The original validators reject foreign repositories, mutable tags, partial digests and invalid source identities. The rule uses the declared public profile, reviewed YAML, AppArmor policy, installer sources and fixed kubectl; it does not read host credentials, apply resources or contact the VPS.

The resulting directory contains rendered foundation/runtime resources, allowed setting names, pinned versions, standard units and stdlib installer modules. `manifest.json` binds their bytes to the source SHA and image references. These checksums establish internal consistency. Actions uploads the same directory through `package-vps`.

## Installer contract

The supported host is Ubuntu 24.04 Linux amd64 with its existing Python stdlib, systemd, network prerequisites and enabled AppArmor parser/includes. No application Python runtime is installed on the host. K3s, cloudflared and image versions/checksums come from the reviewed bundle and [versions.json](../../platform/versions.json). Tunnel transport also needs its documented outbound connectivity.

Host installation and recovery require the owner's separate authorization and controlled runbook. The public bundle contains no credentials or private state. Private inputs remain outside Git, images and logs; their shape and independent-token checks are enforced by `config.py` and generated `allowedkeys.json`. They cannot override controlled paths, release identities, service URLs or loader variables.

The installer preserves the stopped source state, creates only its declared services/resources, and refuses foreign managed files or nonempty conflicting destinations. The existing SSH connector stays outside its scope. It uses namespace-scoped rotating Kubernetes identities; the deployment client never receives cluster-admin credentials.

Initial Newsletter admission remains held and its daily trigger suspended. `complete_held` records completion of bootstrap only. The first verified Actions release must use the bootstrap source identity, check drain/freeze, actual digest/generation/process provenance, then resume admission and the trigger. Unknown business outcomes and frozen inputs stay intact.

## Fixed node address and DNS

`node_address.py` owns the reviewed fixed address, dummy interface, K3s dependency and explicit resolver set. Neither the API address nor cluster DNS depends on DHCP. It checks existing network/configuration ownership before changes, and waits for the Node address, API EndpointSlice, in-Pod API access and DNS observations. The exact constants and accepted prior templates live in that module; the public documentation does not duplicate them.

A matching retry verifies existing state. The explicit rollback restores the prior reviewed configuration; it does not discard application state. A failed or partial migration stops for review. See [host address recovery](../../docs/rebuild.md#主机地址变化).

## Recovery boundaries

A completion marker binds one exact public bundle. Repeating that completed bundle reports `already_initialized`; a different bundle uses the normal release path. An incomplete retry keeps the same input and checkpoint. Neither path forces unknown deliveries complete, deletes old state, reopens admission or starts a retired Compose stack.

<a id="initial-client-repair"></a>

The bounded `repair.py` compatibility path is for the original bootstrap client and an empty API release ledger. It accepts only a reviewed replacement with unchanged host/foundation configuration, preserves queued and unknown business records, and finishes held. It is not a general second installer or an API resume. Host-address migration remains a separate operation.

Optional diagnostics use a distinct restricted reader identity. Read access does not authorize deployment, host changes or credential redistribution.

## Checks

```sh
bazel test //tools/vps-bootstrap:check //platform/tests:tests
```

Synthetic tests cover ownership refusal, partial copies, stable release identities, drain handoff, retry checkpoints and recovery. They do not establish live Tunnel connectivity, provider authentication, restored data completeness or successful delivery. The Linux image job additionally exercises isolated K3s SSA; the AppArmor parser check compiles the policy without loading it.
