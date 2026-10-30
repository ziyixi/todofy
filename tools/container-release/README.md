# Tested service images

The stable release roots are `//newsletter`, `//platform` and `//codex-gateway`. They produce Linux amd64 OCI archives from the root lock and fixed base; each application's `:check` owns its tests and `:config` exposes static deployment inputs.

Each Linux Docker `:container_test` loads the declared archive, verifies its filesystem/configuration, freezes the actual local image ID and runs the original offline probe. These local, exclusive tests are not cached and receive no host credentials or auth mounts. The ordinary unstamped test image has an explicit zero source identity.

`build.py` produces a stamped candidate, loads it and requires a nonzero source SHA matching checkout HEAD. SHA changes affect the terminal identity layer. Candidate Actions repeat the original probes on that exact image ID, then `image.py save` records source, image ID and archive SHA256. The gated main publisher reloads and verifies the same archive before pushing; it never rebuilds.

Exact-SHA branch reuse additionally requires the unexpired tested archive. Missing material causes a fresh candidate build. Archives are short-lived promotion inputs; production references registry digests. Image publication does not deploy the VPS, collect content or send mail.

Only the gated publisher has Packages Write. Cloudflare secrets, VPS access, model login and private content do not enter image checks. Actions continues to own publication, deployment ordering and actual delivery verification.
