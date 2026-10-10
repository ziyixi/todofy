# recall sync

The reference archive consumer of [`recall-archive-v1`](../../contracts/recall-archive-v1/README.md): a small container
on the owner's NAS that pulls recall's change feed every 15 minutes into plain files (one JSON line per change, one
file per UTC day, the captured texts as gzip files and a `state.json`), readable for decades with `find`, `zcat`,
`grep` and `jq`. It only connects out, to recall's two machine routes with the export token; the NAS opens no port.
Design: [`../docs/design.md`](../docs/design.md) §7.

| Path | What it is |
| --- | --- |
| `recall_sync.py` | The consumer: the contract's §4 step by step, one file, Python's standard library only (3.12+) |
| `test_recall_sync.py` | Its tests: the contract's consumer tests (§5) against its fixtures and a loopback fake of recall, the HTTP rules, crashes between every two steps, the store driver, the loop and the configuration |
| `requirements-test.txt` | The reference JSON Schema validator, for the test that compares the consumer's rules with the generated schema |
| `Dockerfile` | The image `ghcr.io/ziyixi/recall-sync`: that one file on a pinned `python:3.12-slim`, uid 10001, no port |

## What it does

Each run reads `VERSION` and `state.json`, asks for the changes after its `synced_seq` (500 at a time) and checks each
page whole before applying any of it: the version, the feed's identity, the cursor, and every change against the
contract's schema (a change of a newer kind is kept whole, checked on its envelope). It then writes, each file
atomically and in this order: the changes into today's day file, every blob after checking its size and SHA-256,
the deletions of the page's tombstones (a deleted page's lines and blobs leave every day file), and `state.json` last.
A crash anywhere leaves `state.json` at the last fully applied page, and the next run repeats the rest. The archive's
layout and how to read it are in the contract's §3.

At the volume the design measured, an archive grows by well under 1 GB a year. A new archive started from `after=0` on
a long feed puts that whole history into the day it was pulled (the contract files changes by the day they were
applied); copying the old archive avoids that (the contract's §5).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RECALL_EXPORT_TOKEN` | (required) | The export token; `mint-tokens.mjs` writes it into `recall-sync.env` |
| `RECALL_EXPORT_TOKEN_FILE` | | Instead: a file holding only the token (a Docker secret), read again before every run |
| `RECALL_BASE_URL` | `https://recall.ziyixi.science` | recall's origin; plain `http://` only to `127.0.0.1` or `localhost` (a local `wrangler dev`) |
| `RECALL_ARCHIVE_DIR` | `/archive` | The archive root; it must exist (a share that is not mounted is never created) |
| `RECALL_CONSUMER` | `nas` | This archive's name in recall's 设置 → 归档 (`[a-z][a-z0-9-]{0,31}`) |
| `RECALL_INTERVAL_SECONDS` | `900` | The pause between two catch-ups (60 to 86400) |

`recall_sync.py` with no argument pulls until stopped; `--once` catches up once (exit 0 when caught up, 1 when the run
ended early); `--check` is the health check (exit 0 when `state.json` was written within three intervals). A bad
variable exits 2.

## Running it on the NAS

After recall's first deploy and `node recall/deploy/mint-tokens.mjs` on the Mac (which leaves the export token in
`~/recall-sync.env`, mode 0600). The paths below are placeholders: `<archive>` is the shared folder that holds the
archive and `<secrets>` a folder only the owner can read; the NAS's own names for them stay out of this repository.

1. **The image.** In GitHub Actions, run the workflow "recall sync image" on `main`. Its summary prints
   `ghcr.io/ziyixi/recall-sync@sha256:…`: use that reference, never `latest`. GHCR makes a new package private; make
   `recall-sync` public in its package settings (it holds one file of this public repository), or log the NAS's
   Docker in to `ghcr.io` with a token that can only read packages.
2. **The share.** Create a shared folder for the archive, private to the owner's account. The container writes as
   uid 10001: either give that uid the folder (`chown 10001:10001 <archive>`), or run the container as the owner's own
   NAS account (`user: "<uid>:<gid>"` below) so the files are theirs. Files are written mode 0644 inside the folder;
   the folder's own permissions keep others out.
3. **The token.** Copy `recall-sync.env` into `<secrets>`, keep it mode 0600, and delete the copy on the Mac. Docker
   reads it when it creates the container, so a new token means recreating the container.
4. **The container.** In the NAS's Docker, create a project with this compose file:

   ```yaml
   services:
     recall-sync:
       image: ghcr.io/ziyixi/recall-sync@sha256:<the digest from step 1>
       restart: unless-stopped
       env_file: <secrets>/recall-sync.env
       volumes:
         - <archive>:/archive
       # user: "<uid>:<gid>"   # instead of chown in step 2
       read_only: true
       cap_drop: [ALL]
       security_opt: [no-new-privileges:true]
   ```

   The same with `docker run`: `docker run -d --name recall-sync --restart unless-stopped --env-file <env file>
   -v <archive>:/archive --read-only --cap-drop ALL --security-opt no-new-privileges <image>`.
5. **The check.** Within a minute the container's log shows `{"event": "synced", …, "caught_up": true}` and the
   folder holds `VERSION`, `state.json` and `changes/`; the container turns healthy at its first health check (every
   five minutes), and recall's 设置 → 归档 shows `nas` synced. An upgrade is the same compose file with a newer digest.

## When it stops

Logs are JSON lines with codes, counts and seqs only, never a URL, a title, a text or the token.

| Code | Meaning | What to do |
| --- | --- | --- |
| `export_token_refused` | recall refused the token (401) | Put the current token into the env file (`mint-tokens.mjs --rotate export` makes a new one; `--revoke export` when the old one leaked) and recreate the container; until then it asks again once an hour |
| `export_token_unreadable`, `export_token_invalid` | `RECALL_EXPORT_TOKEN_FILE` cannot be read, or holds more than the token | Fix the file; it is read again before every run |
| `feed_changed`, `cursor_ahead`, `cursor_expired` | recall's store was reset or restored to an earlier point: this archive cannot follow it | Nothing more is pulled into this folder (said once an hour; the health check fails). Keep the folder as it is, complete up to its `synced_seq`, and point the container at a new empty folder (the contract's §5) |
| `archive_version`, `archive_invalid`, `archive_state_invalid`, `archive_corrupt` | The folder is not an archive this consumer understands, or a file in it was edited | Check the mount; never edit the archive by hand |
| `archive_root_missing`, `store_error` (with `errno`) | The share is not mounted at `/archive`, or cannot be written (`EACCES`: step 2; `ENOSPC`: a full disk) | Fix the mount or the permissions; it retries every interval |
| `export_token_missing`, `consumer_invalid`, … (`config_invalid`, exit 2) | A variable is missing or breaks its rule | Fix the env file or the compose file |
| `network`, `redirect_refused`, `invalid_page`, `changes_http_<status>`, `blob_http_<status>`, `blob_digest_mismatch`, `blob_too_large` | The run ended early and nothing advanced | It retries every interval (or after `Retry-After`: recall answers 429 for the rest of the UTC day once its daily read budget for the feed is spent, so a long catch-up takes several days); when it keeps failing, recall's 设置 and Home show the archive falling behind |

A blob that recall answers 410 (its page was deleted since) is skipped as the contract says; any other answer for a
blob, 404 included, ends the run.

## Tests and local runs

In `recall/`:

```sh
python3 -m unittest discover -s sync -p 'test_*.py'          # standard library only; the schema comparison skips
uv run --no-project --python 3.12 --with-requirements sync/requirements-test.txt \
  python -m unittest discover -s sync -p 'test_*.py'          # with it, as Recall checks runs
```

Against a local `wrangler dev` (synthetic tokens only):
`RECALL_BASE_URL=http://127.0.0.1:8787 RECALL_EXPORT_TOKEN=<synthetic> RECALL_ARCHIVE_DIR=<empty folder> python3 sync/recall_sync.py --once`.

## Another store, another consumer

The consumer talks to its archive through `Store`'s five operations (`read`, `write_atomic`, `exists`, `delete`,
`list`). A WebDAV server or an S3-compatible bucket is a new class of those five, constructed where `attempt()` builds
`DirStore`; nothing else changes. A consumer in another language follows the contract's §4 and passes its §5 tests,
which `test_recall_sync.py` shows in Python.

## The image

`.github/workflows/recall-sync-image.yml`, dispatched by hand: the tests (with the schema comparison), then on a branch
a build that is tested without publishing, on `main` a build that is tested and pushed as `sha-<commit>` and `latest`,
its digest in the run summary. Both builds run the consumer's tests on the image's own Python with no network, a
read-only root and no capabilities, as uid 10001. The base image is pinned by digest, the same Python as Platform's and
Newsletter's images; bump them together.
