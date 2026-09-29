# Mail Hero backup collector and isolated restore

The collector and its daily scheduler run in a single Docker Compose service. GitHub Actions builds the Python/GPG image; the existing server pulls its immutable GHCR digest. The Mail Hero application and database remain on Cloudflare. Existing Vultr backups and their private environment files are not modified.

The backup scope is **Mail Hero application data and recovery state only**. It does not back up the host OS, home directory, Docker volumes, or other services. The container runs as UID/GID 1000 with a read-only root filesystem and no Docker socket. No systemd unit, host cron or additional sudo installation is needed.

`collect` acquires a bounded Worker lease, verifies canonical D1 export pages and exact R2 object sizes/ETags, writes a private local archive, encrypts it to a pinned public key, uploads 16 MiB parts to the separate backup binding, and downloads the encrypted result to verify its full SHA-256. Only then does it sign the independent receipt and call `finish`. `finish` is the durable success point. D1 and R2 content, custom/HTTP metadata, intake/control state, snapshot boundary, and an optional already-encrypted key escrow are included. Post-boundary arrivals belong to the next snapshot.

Each successful run keeps a local encrypted copy and a non-content receipt. After remote success, local and remote rotation keep the latest snapshot on 7 distinct UTC days and 4 distinct ISO weeks (at most 11 snapshots; overlap can reduce this). Failed/unverified local ciphertext is left for inspection and is not counted as a backup. Plaintext staging lives only in a private temporary directory and is removed on normal exit/failure; an abrupt host crash can leave `.snapshot-*` directories, which must be removed only after confirming no collector process is using them. The service's output directory must have mode 0700 and sufficient space for source bytes, a compressed archive, and encrypted output concurrently. No credentials or mail content are logged.

## Compose deployment

Only these machine credentials are required: dedicated `BACKUP_TOKEN`, independent 64-hex `BACKUP_RECEIPT_KEY`, and an Access service token pair `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` restricted to `/api/internal/backup/*`. The collector does **not** need a Cloudflare admin API token, Wrangler login, D1 administrator key, R2 S3 key, `CREDENTIAL_KEY` plaintext, or the recovery private key. `BACKUP_STORE` is separate from `MAIL_STORE` and existing backup buckets. If Access is not used in an isolated development environment, omit both Access variables together.

The [self-host-on-vultr Compose service](https://github.com/ziyixi/self-host-on-vultr/tree/main/mailhero-backup) uses these existing directories, outside the other backup's `./data` and `./env` trees:

| Host path | Container path | Access |
| --- | --- | --- |
| `/home/xiziyi/.config/mail-hero-backup` | `/run/mailhero-backup` | Read-only; mode 0700 directory, 0600 files |
| `/home/xiziyi/mail-hero-backup` | `/var/lib/mailhero-backup` | Read/write; mode 0700 |

The config directory contains `credentials.env`, `recovery-public.asc`, and `credential-key.gpg`. The runtime reads the environment file as data, never executes it as shell code, and never prints its values. The public image contains only code and dependencies. Configuration and backup archives are mounted at runtime.

Generate the recovery key on a separate trusted device, export **only the armored public key** to the server, and pin its full fingerprint in `BACKUP_RECIPIENT`. Keep the private key and an independent encrypted `CREDENTIAL_KEY` backup off the server. The collector creates a temporary public-only keyring and rejects private-key exports. The container includes the already public-key-encrypted `credential-key.gpg`; it neither decrypts nor generates the application key.

Prepare the encrypted application-key escrow from an explicit input file, then decrypt it on the recovery device and compare it in memory with the original 64-hex key before copying the ciphertext to the server. GPG can successfully encrypt empty input; a successful GPG exit or a nonempty ciphertext does not prove that the key is present. Repeat the comparison against the escrow extracted from the completed backup during the real restore rehearsal. Never print the decrypted key or replace the live application key to make a recovery test pass.

After synthetic tests, a supervised real collection and an isolated recovery rehearsal have passed, start only this service from the deployment repository:

```sh
docker compose pull mailhero-backup
docker compose up -d --no-deps mailhero-backup
docker compose ps mailhero-backup
```

The scheduler runs daily at **04:17 UTC**, configurable with `BACKUP_AT_UTC=HH:MM`. On restart, it checks the local verified receipt and catches up if the latest scheduled backup was missed. Failures wait one hour before retrying, including across container restarts. A shared file lock prevents overlap with a manual run. Graceful shutdown cancels the active lease and cleans temporary plaintext; an abrupt host failure still requires checking abandoned staging directories.

To request one backup or check the scheduler locally:

```sh
docker compose run --rm --no-deps mailhero-backup once
docker compose exec -T mailhero-backup python3 -I /app/container.py health
docker compose logs --tail=20 mailhero-backup
```

The healthcheck uses local heartbeat and successful-backup freshness; it does not repeatedly query Cloudflare. A successful upload alone is not recovery proof. Actual collection, restore and deployment facts are recorded separately in [the verification record](../../docs/verification-native.md).

The maximum lease is 30 minutes. If export/encryption/upload/read-back cannot complete in that window, the run must fail; it cannot declare success after lease expiry or silently extend the consistency window. On errors it cancels the lease and aborts any incomplete multipart upload where possible. Network response bodies are not printed. The Worker independently expires abandoned leases. There is no automatic upgrade to a paid plan.

Before collection can succeed, every live database reference to a raw message, parsed message, retained attachment or frozen webhook payload must exist in the checked inventory. Payload size and SHA-256 must match the frozen database record. Restore repeats these checks after applying deletion/expiry records. Missing referenced content fails closed; successfully hashing the files that happen to exist is not sufficient.

## Restore on the recovery device

Fetch the latest independently stored deletion ledger immediately before recovery, using the dedicated machine credentials. Keep its freshness separate from the old snapshot. If the live service is unavailable, retrieve the latest `deletion-journal/` objects from the independent backup bucket through a separately authorized recovery route and build the same version-1 document; do not substitute an old snapshot's journal and call it current.

```sh
python3 mailhero_backup.py deletions --origin "$MAIL_HERO_ORIGIN" \
  --output /private/recovery/latest-deletions.json
python3 mailhero_backup.py restore --archive /private/recovery/snapshot.tar.gz.gpg \
  --archive-sha256 "$VERIFIED_ARCHIVE_SHA256" \
  --destination /private/recovery/new-isolated-mailhero \
  --latest-deletions /private/recovery/latest-deletions.json \
  --gpg-home /private/recovery/keyring
```

The destination must not exist. Obtain `VERIFIED_ARCHIVE_SHA256` from the independently saved successful receipt; public-key encryption by itself does not prove who created an archive. Restore validates archive paths, sizes, hashes, schema pages and object metadata; it creates a new local `database.sqlite`, a loadable `database.sql`, hashed object files plus `r2-objects.json` containing their original keys/metadata, and `coordinator-control.json`. Snapshot and current deletion entries are applied before exposing this isolated result, including attachment copies, search text and frozen payloads. Raw-only expiry keeps retained parsed content. The journal format is `{version:1,fetched_at:<ISO>,items:[{id:<message UUID>,scope:"raw"|"content",deleted_at:<ISO>}]}`. A provided journal must have been fetched after the snapshot cut; the operator must still establish that it is the latest independent journal.

Without a latest journal, the output is explicitly `quarantined_missing_latest_deletions`. Even with one, `activation_allowed` stays false. The restored DB pauses the application and all webhook endpoints, and uncertain sending events become `failed / restore_reconciliation_required` while retaining event IDs and exact payload bytes. The tool does not reconstruct live DO alarms, publish a Worker, import into Cloudflare, or contact a consumer. These are deliberate separate recovery steps:

1. Create new empty D1 and R2 resources; never overwrite the running source. Deploy the reviewed schema/code with `MAINTENANCE_MODE=true` and `FORCE_SEND_PAUSED=true`.
2. Import the verified SQL and upload each surviving object to its original key with its original metadata; verify bytes/hashes again. Restore the original independently escrowed `CREDENTIAL_KEY`; do not generate a replacement and lose endpoint decryption.
3. Rebuild DO intake/capacity/job state from the control snapshot while preserving failure-stop counts, sequence boundary and conservative quota state. Reconcile current object byte accounting. Merely importing D1 does not restore DO alarms.
4. Compare unknown deliveries with the consumer by original event ID. Do not create fresh events or unpause them automatically. Confirm the latest external deletion journal once more before making mail content accessible.
5. Only after these checks and a controlled synthetic test, explicitly activate intake/processing and decide which existing deliveries may resume. The local restore test is not evidence of a live Cloudflare disaster recovery or an established RPO/RTO.

## Tests

```sh
python3 -m unittest discover -s deploy/backup -p 'test_*.py' -v
```

Tests use only synthetic data and the real repository SQLite schema. They cover paginated collection, immutable payload bytes, metadata preservation, independent SQL reload, forced pause, content deletion and raw expiry, corrupt objects, traversal/symlink rejection, cancellation, rotation, and (when `gpg` is present) an ephemeral public-key encryption/decryption/restore round trip. No real mail or account credentials are fixtures.
