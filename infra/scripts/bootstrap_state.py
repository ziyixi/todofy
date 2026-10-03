#!/usr/bin/env python3
"""One-time bootstrap of the encrypted remote state in R2 (run once, locally, by whoever holds the token).

    export INFRA_STATE_PASSPHRASE="$(cat ~/.config/todofy-infra/state-passphrase)"   # or --passphrase-file
    python3 infra/scripts/bootstrap_state.py --var-file ~/.config/todofy-infra/local.tfvars

Steps (each prints one fixed line; no value, token, key or id is ever printed):
1. Preconditions: OpenTofu 1.12, the passphrase (encryption is enforced; no unencrypted fallback), the values
   file outside the repository, the Cloudflare token from the Mail Hero admin helper's token file.
2. Derive the R2 S3 credentials from the token (infra_state.py) and look for the private bucket "infra-state";
   create it if missing through the admin helper's wrangler wrapper (mail-hero/deploy/cloudflare-admin.py),
   which reads the token itself. Wrangler runs in the private work directory, so it finds no wrangler.toml to edit.
3. Probe whether R2 honours conditional writes (If-None-Match: *) on a throwaway key. Report only: the backend
   keeps no lock file until a later change enables use_lockfile.
4. Note whether the state object exists, then `tofu init` with the S3 backend (key <environment>/terraform.tfstate).
5. Plan. It must hold ONLY imports: every resource is "import" (or already "no-op"), exactly --expect of them,
   and outputs only created (a new state has none yet). Anything else (create, update, replace, delete, forget,
   import+update, an output update, a wrong count) refuses before any apply. An EXISTING state object may only be
   verified: a plan that would import into it (or create outputs in it) refuses too, because every change to the
   populated state goes through "Infra apply" on main (backup, gates, concurrency group; README.md "Apply").
6. `tofu apply` of exactly that saved import-only plan, only when the state object did not exist. Import reads
   Cloudflare and writes only the state.
7. Read the state object back: it must be OpenTofu-encrypted (no plaintext resources).
8. Plan again: it must say "No changes" (exit 0, every resource no-op).

It needs the import {} blocks, which were removed after the first P4 apply: restore infra/imports.tf from git
history on a branch first (README.md "Removing the import blocks").
Re-running on an existing state only verifies it (step 6 is skipped, or the run refuses). tofu's own output goes
to a 0600 log in a new private work directory under ~/.cache/todofy-infra (outside the repository, kept for local
debugging; plan files are deleted; an existing directory is never reused, chmodded or removed).
Exit codes: 0 done; 1 error; 4 the plan held something other than imports, or would change an existing state
(nothing was applied).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import infra_state  # noqa: E402  (same directory)
from infra_state import Refused  # noqa: E402

REPO = infra_state.REPO
ADMIN = REPO / "mail-hero" / "deploy" / "cloudflare-admin.py"
WRANGLER = REPO / "mail-hero" / "cloudflare" / "node_modules" / ".bin" / "wrangler"
# The objects infra/ manages (README.md "Managed here (19 objects)"; test_infra_config.py ties the two together and to
# the keys of access.tf and storage.tf, so adding an object without raising this fails the Changes job).
EXPECTED_OBJECTS = 28
EXIT_NOT_IMPORT_ONLY = 4


class NotImportOnly(Refused):
    """The first plan holds something other than imports: nothing is applied."""


class StateExists(Refused):
    """The plan would write to a state object that already exists: nothing is applied ("Infra apply" does that)."""


def step(number: int, text: str) -> None:
    print(f"[{number}/8] {text}", flush=True)


def import_decision(summary: dict, expected: int) -> str:
    """"apply" for an import-only plan, "done" when every object is already in the state; Refused otherwise.

    Messages hold action words and counts only, never an address or a value."""
    counts = infra_state.counts(summary)
    other = {word: n for word, n in counts.items() if word not in ("import", "no-op")}
    if other:
        raise NotImportOnly(f"the plan holds actions other than import: {dict(sorted(other.items()))}")
    if any(word != "create" for word, _ in summary["outputs"]):
        raise NotImportOnly("the plan changes outputs other than by creating them")
    total = len(summary["rows"])
    if total != expected:
        raise NotImportOnly(f"the plan covers {total} resources, expected exactly {expected}")
    return "apply" if counts.get("import") or summary["outputs"] else "done"


def state_exists(session: infra_state.Session, environment: str) -> bool:
    """Whether the remote state object exists (HEAD: 200 yes, 404 no; anything else refuses)."""
    status, _ = session.s3("HEAD", infra_state.state_key(environment))
    if status not in (200, 404):
        raise Refused(f"cannot tell whether the remote state object exists (HTTP {status})")
    return status == 200


def final_check(tofu_code: int, summary: dict, expected: int) -> None:
    counts = infra_state.counts(summary)
    if tofu_code != 0 or counts != {"no-op": expected} or summary["outputs"]:
        raise Refused(f"the final plan is not \"No changes\" (exit {tofu_code}, actions {dict(sorted(counts.items()))})")


def read_passphrase_file(path: Path) -> str:
    info = path.expanduser().stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Refused("the passphrase file must be an owner-only regular file (chmod 600)")
    return path.expanduser().read_text().strip()


def load_admin():
    spec = importlib.util.spec_from_file_location("cloudflare_admin", ADMIN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def tofu_version(binary: str = "tofu") -> str:
    try:
        result = subprocess.run([binary, "version", "-json"], capture_output=True, text=True, check=True)
        return json.loads(result.stdout)["terraform_version"]
    except (OSError, subprocess.CalledProcessError, ValueError, KeyError):
        raise Refused("cannot run `tofu version`; install OpenTofu 1.12") from None


def run_admin_wrangler(token_file: Path, args: list[str], work: Path, log: Path) -> int:
    if not WRANGLER.exists():
        raise Refused("wrangler is not installed for the admin helper: run `npm ci --prefix mail-hero/cloudflare`")
    with open(log, "a") as handle:
        handle.write(f"\n$ cloudflare-admin.py wrangler {' '.join(args[:3])}\n")
        handle.flush()
        return subprocess.run(
            [sys.executable, str(ADMIN), "--token-file", str(token_file), "wrangler", *args, "--cwd", str(work)],
            stdout=handle, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        ).returncode


def ensure_bucket(session: infra_state.Session, create: Callable[[], int], sleep=time.sleep) -> str:
    status, _ = session.s3("HEAD", "")
    if status == 200:
        return "exists"
    if status != 404:
        raise Refused(f"the derived R2 credentials cannot reach the state bucket (HTTP {status})")
    if create() != 0:
        raise Refused("creating the state bucket failed (see the log in the work directory)")
    for _ in range(10):
        status, _ = session.s3("HEAD", "")
        if status == 200:
            return "created"
        sleep(2)
    raise Refused(f"the state bucket is not reachable after creation (HTTP {status})")


def probe_conditional_writes(session: infra_state.Session) -> str:
    key = f"probe/conditional-write-{secrets.token_hex(8)}"
    guard = {"If-None-Match": "*"}
    try:
        first, _ = session.s3("PUT", key, b"probe", guard)
        second, _ = session.s3("PUT", key, b"probe", guard)
    finally:
        session.s3("DELETE", key)
    if first == 200 and second == 412:
        return "honoured (If-None-Match: * refused the second write); use_lockfile can be enabled in a later change"
    return f"not proven (HTTP {first} then {second}); keep the concurrency group, no use_lockfile"


def bootstrap(args: argparse.Namespace, env: dict[str, str], admin=None) -> int:
    expected = args.expect
    step(1, "preconditions: OpenTofu, passphrase, values, token")
    version = tofu_version()
    if not re.fullmatch(r"1\.12\.\d+", version):
        raise Refused(f"OpenTofu 1.12.x is required (found {version})")
    if args.passphrase_file:
        env[infra_state.PASSPHRASE_ENV] = read_passphrase_file(args.passphrase_file)
    infra_state.passphrase(env)
    values = infra_state.read_values_argument(args.var_file, env)
    admin = admin or load_admin()
    token_file = (args.token_file or admin.DEFAULT_TOKEN).expanduser()
    try:
        env["CLOUDFLARE_API_TOKEN"] = admin.credential(token_file)
    except (OSError, ValueError):
        raise Refused("the admin helper's token file is unavailable (owner-only file, chmod 600)") from None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    # A new private directory under the parent (never an existing one): it keeps only tofu's log afterwards.
    work = infra_state.new_work_dir(args.work_dir or Path.home() / ".cache" / "todofy-infra", env,
                                    prefix=f"bootstrap-{stamp}-")
    session = infra_state.Session(environment=args.environment, values=values, work=work, env=env,
                                  s3_endpoint=args.s3_endpoint)
    print(f"work directory (log only, outside the repository): {work}")
    try:
        step(2, "R2 credentials derived from the token; state bucket")
        if args.s3_endpoint:
            state = ensure_bucket(session, lambda: 1)
        else:
            state = ensure_bucket(
                session, lambda: run_admin_wrangler(token_file, ["r2", "bucket", "create", infra_state.BUCKET], work, session.log)
            )
        print(f"  bucket {infra_state.BUCKET}: {state}")

        step(3, "conditional-write probe (report only)")
        print("  " + (probe_conditional_writes(session) if not args.skip_lock_probe else "skipped"))

        step(4, "tofu init with the S3 backend")
        existed = state_exists(session, args.environment)
        print("  state object: " + ("exists (this run may only verify it)" if existed else "missing (a new state)"))
        session.tofu.init(args.environment)

        step(5, f"plan: must hold only imports ({expected})")
        _, summary, rendered = session.plan("import")
        print(rendered)
        decision = import_decision(summary, expected)
        if decision == "apply" and existed:
            raise StateExists("the remote state already exists: changes to it go through \"Infra apply\" "
                              "(infra/README.md \"Apply\"); nothing was applied")

        if decision == "apply":
            step(6, "apply the import-only plan (writes the encrypted state; Cloudflare is only read)")
            session.tofu.apply(session.work / "import.tfplan")
        else:
            step(6, "skipped: the remote state already holds every object")

        step(7, "the remote state object is encrypted")
        status, body = session.s3("GET", infra_state.state_key(args.environment))
        if status != 200 or not infra_state.encrypted_state(body):
            raise Refused(f"the remote state object is missing or not encrypted (HTTP {status})")
        print("  encrypted: yes")

        step(8, "final plan: must be \"No changes\"")
        code, summary, rendered = session.plan("final")
        print(rendered)
        final_check(code, summary, expected)
        print("bootstrap_state: done. The remote state holds every object, encrypted; the plan is \"No changes\".")
        return 0
    except Refused as error:
        print(f"bootstrap_state: {error}", file=sys.stderr)
        for line in session.tofu.headlines():
            print(f"bootstrap_state: tofu {line}", file=sys.stderr)
        return EXIT_NOT_IMPORT_ONLY if isinstance(error, (NotImportOnly, StateExists)) else 1
    finally:
        session.cleanup()


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--var-file", type=Path, required=True, help="values file outside the repository (local_tfvars.py)")
    parser.add_argument("--environment", default="production", choices=infra_state.ENVIRONMENTS)
    parser.add_argument("--passphrase-file", type=Path, help="owner-only file holding the passphrase "
                        f"(default: ${infra_state.PASSPHRASE_ENV} or ${infra_state.PASSPHRASE_VAR})")
    parser.add_argument("--token-file", type=Path, help="the admin helper's token file (default: its DEFAULT_TOKEN)")
    parser.add_argument("--work-dir", type=Path, help="parent outside the repository for the new private work "
                        "directory (default: ~/.cache/todofy-infra)")
    parser.add_argument("--expect", type=int, default=EXPECTED_OBJECTS,
                        help=f"number of managed objects (default {EXPECTED_OBJECTS})")
    parser.add_argument("--skip-lock-probe", action="store_true", help="do not probe conditional writes")
    # Tests only: an S3 stand-in instead of R2. The bucket is never created there.
    parser.add_argument("--s3-endpoint", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        return bootstrap(args, dict(os.environ))
    except Refused as error:
        print(f"bootstrap_state: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
