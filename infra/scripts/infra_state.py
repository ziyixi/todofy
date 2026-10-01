#!/usr/bin/env python3
"""Run OpenTofu for infra/ against the encrypted remote state in R2, printing only the redacted summary.

    python3 infra/scripts/infra_state.py plan --environment production [--var-file F] [--work-dir D]
    python3 infra/scripts/infra_state.py apply --environment production   # only inside "Infra apply" on main
    python3 infra/scripts/infra_state.py list-backups --environment production [--var-file F]

Used by .github/workflows/infra.yml (daily drift plan), .github/workflows/infra-apply.yml (the apply, P4) and by
bootstrap_state.py (one-time import). It:
- refuses to run without the state passphrase (TF_VAR_state_passphrase or INFRA_STATE_PASSPHRASE): state and
  plan encryption are enforced in versions.tf and there is no unencrypted fallback;
- derives the R2 S3 credentials from CLOUDFLARE_API_TOKEN at runtime (access key id = the token's id from
  the verify endpoint, secret access key = SHA-256 of the token), masks them under GitHub Actions and passes
  them to tofu through the environment only. Fallback when derivation is not possible: INFRA_R2_ACCESS_KEY_ID
  and INFRA_R2_SECRET_ACCESS_KEY (README.md "Remote state");
- runs `tofu init` with the S3 backend and `tofu plan -detailed-exitcode -out`, sending tofu's own output to
  a 0600 log inside a private work directory outside the repository, never to the terminal;
- reads `tofu show -json` into memory (never to disk) and prints tools/infra-plan-summary's summary only;
- checks the planned outputs (outputs.tf) against the apps' production wrangler.toml files: every ACCESS_AUDIENCE,
  D1 database_id and R2 bucket_name must equal what the managed objects hold (names only are printed);
- `apply` (README.md "Apply"): runs only inside the "Infra apply" workflow dispatched on main (accident-proofing,
  not a security boundary). Copies the encrypted state object to a dated key in the same private bucket, plans,
  refuses before any write unless the plan passes every gate (no delete/replace/forget unless confirmed, only
  ALLOWED_TYPES, no write to a FROZEN object by address, previous address or id, exactly the expected counts and
  plan fingerprint, outputs equal to the wrangler configs), then applies exactly that saved plan and plans again,
  which must be "No changes";
- `list-backups`: the keys of the apply's state backups (keys only; README.md "Rotating the passphrase").

Values come from --var-file (a tfvars file written by local_tfvars.py, or JSON) or from the INFRA_TFVARS
environment variable (the GitHub secret, JSON). `values-json --var-file F | gh secret set INFRA_TFVARS ...`
turns a local values file into that secret without showing it (it refuses to write to a terminal). Errors are fixed messages; a failed tofu step prints only
its sanitised "Error:" headlines (no quoted strings, addresses, ids or long tokens).

Exit codes: 0 no planned action (plan) or done (apply); 1 error or a refused apply; 2 planned actions (drift); 3 a
delete, replace or forget; 5 an output differs from a wrangler.toml.
Standard library only, Python 3.9+ (the wrangler.toml check needs tomllib, 3.11+; an older python3 skips it locally
with a notice, and on a runner it is an error). Tests: python3 -m unittest discover -s infra/tests
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import hmac
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11: the wrangler.toml check is skipped locally (check_outputs)
    tomllib = None

REPO = Path(__file__).resolve().parents[2]
INFRA = REPO / "infra"
SUMMARY = REPO / "tools" / "infra-plan-summary" / "summary.py"
API = "https://api.cloudflare.com/client/v4"
BUCKET = "infra-state"
# One state object per environment (the backend "key" is passed with -backend-config).
ENVIRONMENTS = ("production",)
PASSPHRASE_VAR = "TF_VAR_state_passphrase"
PASSPHRASE_ENV = "INFRA_STATE_PASSPHRASE"
MIN_PASSPHRASE = 16  # OpenTofu's pbkdf2 key provider refuses shorter passphrases
VALUES_ENV = "INFRA_TFVARS"
FALLBACK_KEY_ID, FALLBACK_SECRET = "INFRA_R2_ACCESS_KEY_ID", "INFRA_R2_SECRET_ACCESS_KEY"
REQUIRED_VALUES = (
    "account_id",
    "access_owner_emails",
    "access_github_owner_emails",
    "access_allowed_idp_ids",
    "access_github_idp_id",
)
# Environment that could print values (TF_LOG*), change the configuration behind the committed files
# (TF_ENCRYPTION could add an unencrypted fallback, TF_CLI_ARGS* any flag, TF_VAR_* any variable), point the
# backend elsewhere (AWS_*) or pick another workspace. The child environment never inherits them.
STRIPPED_PREFIXES = ("TF_", "AWS_")
KEPT = ("TF_PLUGIN_CACHE_DIR",)  # a download cache; the lock file's hashes still verify every provider
EXIT_OK, EXIT_ERROR, EXIT_DRIFT, EXIT_DESTRUCTIVE, EXIT_MISMATCH = 0, 1, 2, 3, 5

# --- the apply's gates (README.md "Apply") ---
# Resource types an apply may touch: exactly the guard's boundary (.github/scripts/infra_guard.py ALLOWED_TYPES;
# test_infra_config.py keeps the two equal). A planned change to any other type, or to a data source, refuses.
ALLOWED_TYPES = frozenset({
    "cloudflare_zero_trust_access_application",
    "cloudflare_zero_trust_access_policy",
    "cloudflare_d1_database",
    "cloudflare_r2_bucket",
})
# Objects an apply must never write to (an import, which only reads, is allowed): address -> the object's id. The
# backup app's only policy is application-scoped; whether Cloudflare accepts an application PUT that references it by
# id is unproven (no dry run exists), and a refused or partial PUT would cut off the backup collector. README.md
# "Import notes". The gate matches the address, the previous address (a `moved` rename) and the object id, so a
# refactor cannot slip a write past it; infra_guard.py FROZEN is the same set (test_infra_config.py) and rejects a
# `moved` block that names one, and test_infra_config.py holds the id equal to the committed import id.
FROZEN_OBJECTS = {
    "cloudflare_zero_trust_access_application.mail_hero_backup": "dafc6e08-7b1b-461f-8735-2cfa668a0ce0",
}
FROZEN = frozenset(FROZEN_OBJECTS)
# The literal a dispatch must type to let a plan delete, replace or forget (INFRA_CONFIRM_DESTRUCTIVE). prevent_destroy
# still stops a delete or replace at plan time; removing it is a reviewed commit of its own.
CONFIRM_PHRASE = "delete-replace-forget"
CONFIRM_ENV, EXPECT_ENV = "INFRA_CONFIRM_DESTRUCTIVE", "INFRA_APPLY_EXPECT"
BACKUP_PREFIX = "backups"
# Where `apply` may run: the workflow .github/workflows/infra-apply.yml (its `name:`), dispatched on main. Locally the
# token, the passphrase and the values are all at hand for `plan`; this turns a one-word slip (apply for plan) into a
# refusal. It is accident-proofing, not a security boundary: anyone who can edit this file can remove it.
APPLY_WORKFLOW, APPLY_REF, APPLY_EVENT = "Infra apply", "refs/heads/main", "workflow_dispatch"
# Hex digits of the plan fingerprint (plan_fingerprint): what binds a dispatch to the plan the reviewer saw.
FINGERPRINT_DIGITS = 12

# --- outputs against the apps' configs ---
# The production wrangler.toml of every monorepo Worker (.github/scripts/test_wrangler_configs.py PRODUCTION;
# test_infra_config.py keeps the two equal). The output keys are Worker names and D1 database names.
WRANGLER_CONFIGS = (
    "mail-hero/wrangler.toml",
    "todofy/wrangler.toml",
    "todofy/gateway/wrangler.toml",
    "dashboard/wrangler.toml",
    "website/wrangler.toml",
    "website/relay/wrangler.toml",
    "lab/wrangler.toml",
    "flowday/wrangler.toml",
    "links/wrangler.toml",
)
OUTPUTS = ("access_aud", "d1_database_ids", "r2_bucket_names")


class Refused(Exception):
    """A fixed message that never contains a value."""


# --- inputs --------------------------------------------------------------------------------------------

def passphrase(env: dict[str, str]) -> str:
    """The state passphrase. Encryption is enforced: a missing or short passphrase is an error, never a fallback."""
    direct, secret = env.get(PASSPHRASE_VAR, ""), env.get(PASSPHRASE_ENV, "")
    if direct and secret and direct != secret:
        raise Refused(f"{PASSPHRASE_VAR} and {PASSPHRASE_ENV} are both set and differ; set only one")
    value = direct or secret
    if not value:
        raise Refused(
            f"state encryption is enforced: set {PASSPHRASE_ENV} (or {PASSPHRASE_VAR}); "
            "there is no unencrypted fallback"
        )
    if len(value) < MIN_PASSPHRASE:
        raise Refused(f"the state passphrase must have at least {MIN_PASSPHRASE} characters")
    return value


def parse_values(text: str) -> dict[str, Any]:
    """Values in JSON or in local_tfvars.py's `name = <json>` lines. Exactly the variables of variables.tf."""
    try:
        values = json.loads(text)
    except ValueError:
        values = {}
        for number, line in enumerate(text.splitlines(), 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            match = re.fullmatch(r"\s*([a-z_]+)\s*=\s*(.+?)\s*", line)
            if not match:
                raise Refused(f"values line {number} is not `name = <json value>`") from None
            try:
                values[match.group(1)] = json.loads(match.group(2))
            except ValueError:
                raise Refused(f"values line {number} has a value that is not JSON") from None
    if not isinstance(values, dict):
        raise Refused("the values are not an object of variables")
    if set(values) != set(REQUIRED_VALUES):
        missing = sorted(set(REQUIRED_VALUES) - set(values))
        extra = sorted(set(values) - set(REQUIRED_VALUES))
        raise Refused(f"the values must hold exactly the variables of variables.tf (missing {missing}, unexpected {extra})")
    if not (isinstance(values["account_id"], str) and re.fullmatch(r"[0-9a-f]{32}", values["account_id"])):
        raise Refused("account_id must be 32 lowercase hex digits")
    for name in ("access_owner_emails", "access_github_owner_emails", "access_allowed_idp_ids"):
        if not (isinstance(values[name], list) and values[name] and all(isinstance(v, str) and v for v in values[name])):
            raise Refused(f"{name} must be a non-empty list of strings")
    if not (isinstance(values["access_github_idp_id"], str) and values["access_github_idp_id"]):
        raise Refused("access_github_idp_id must be a non-empty string")
    return values


def outside_repo(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if resolved == REPO or REPO in resolved.parents:
        raise Refused("refusing a work or values path inside the repository; choose a path outside it")
    return resolved


def new_work_dir(parent: Optional[Path], env: dict[str, str], prefix: str = "infra-") -> Path:
    """A fresh private (0700) directory that this run creates and therefore alone may delete.

    --work-dir names its PARENT, never the work directory itself: an existing parent is not chmodded,
    emptied or removed (only a missing one is created), so `--work-dir ~` cannot cost the home directory.
    Without --work-dir the parent is $RUNNER_TEMP on a runner, else the system temp directory."""
    if parent is None:
        base = env.get("RUNNER_TEMP") or None
    else:
        base = outside_repo(parent)
        try:
            base.mkdir(mode=0o700, parents=True, exist_ok=True)
        except OSError:
            raise Refused("cannot create the work directory's parent") from None
    try:
        return Path(tempfile.mkdtemp(prefix=prefix, dir=base))
    except OSError:
        raise Refused("cannot create a work directory in the given parent") from None


def require_fresh_private_dir(path: Path) -> None:
    """Session works only in a directory from new_work_dir(): owner-only, owned by us, still empty."""
    try:
        info = path.lstat()
        empty = not any(path.iterdir())
    except OSError:
        raise Refused("the work directory is missing") from None
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or not empty:
        raise Refused("the work directory must be a new private directory created by this run")


def write_private(path: Path, text: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(text)
    os.chmod(path, 0o600)


# --- R2 S3 credentials ---------------------------------------------------------------------------------

def cloudflare_get(token: str, path: str) -> dict:
    request = urllib.request.Request(
        API + path, headers={"Authorization": "Bearer " + token, "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        raise Refused(f"Cloudflare API HTTP {error.code} for a GET") from None
    except (urllib.error.URLError, OSError, ValueError):
        raise Refused("Cloudflare API unreachable or not JSON") from None
    if not body.get("success"):
        raise Refused("Cloudflare API answered unsuccessfully")
    return body.get("result") or {}


def token_id(account_id: str, fetch: Callable[[str], dict]) -> str:
    """The API token's id: account-owned tokens verify under the account, user tokens under /user."""
    for path in (f"/accounts/{account_id}/tokens/verify", "/user/tokens/verify"):
        try:
            result = fetch(path)
        except Refused:
            continue
        if result.get("status") != "active":
            raise Refused("the Cloudflare API token is not active")
        identifier = result.get("id")
        if isinstance(identifier, str) and re.fullmatch(r"[0-9a-f]{32}", identifier):
            return identifier
        raise Refused("the verify endpoint returned no usable token id")
    raise Refused(
        "cannot read the token id from either verify endpoint; use the fallback "
        f"{FALLBACK_KEY_ID}/{FALLBACK_SECRET} (infra/README.md \"Remote state\")"
    )


def s3_credentials(env: dict[str, str], account_id: str, fetch: Callable[[str], dict]) -> tuple[str, str]:
    """(access key id, secret access key): the explicit fallback pair if set, else derived from the token."""
    key_id, secret = env.get(FALLBACK_KEY_ID, ""), env.get(FALLBACK_SECRET, "")
    if key_id or secret:
        if not (key_id and secret):
            raise Refused(f"set both {FALLBACK_KEY_ID} and {FALLBACK_SECRET}, or neither")
        return key_id, secret
    token = env.get("CLOUDFLARE_API_TOKEN", "")
    if not token:
        raise Refused("set CLOUDFLARE_API_TOKEN in the environment")
    return token_id(account_id, fetch), hashlib.sha256(token.encode()).hexdigest()


def on_actions_runner(env: dict[str, str]) -> bool:
    """A GitHub Actions job (all three are set by the runner). Never set these locally: the mask commands below
    would then print the values to the terminal, because only the runner consumes them."""
    return env.get("GITHUB_ACTIONS") == "true" and bool(env.get("GITHUB_RUN_ID")) and bool(env.get("RUNNER_TEMP"))


def _command_data(value: str) -> str:
    """A workflow-command argument escaped like @actions/core's escapeData (a newline cannot end the command)."""
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def mask(values: list[str], env: dict[str, str], out=None) -> None:
    """Ask the GitHub Actions runner to mask each value in every later log line (no-op anywhere else).

    Only for values the runner does not know as a whole: the token and the passphrase come from `secrets.*`,
    which GitHub masks already; the derived access key id and secret access key are new strings; and GitHub
    masks the INFRA_TFVARS secret only as its whole JSON string, never the values inside it."""
    if not on_actions_runner(env):
        return
    out = out or sys.stdout
    seen: set[str] = set()
    for value in values:
        if value and value not in seen:
            seen.add(value)
            out.write(f"::add-mask::{_command_data(value)}\n")
    out.flush()


def value_scalars(values: dict[str, Any]) -> list[str]:
    """Every string inside the values (account id, identity provider ids, both email lists), in a fixed order."""
    found: list[str] = []
    for name in REQUIRED_VALUES:
        value = values[name]
        found.extend(value if isinstance(value, list) else [value])
    return found


def endpoint(account_id: str) -> str:
    return f"https://{account_id}.r2.cloudflarestorage.com"


def state_key(environment: str) -> str:
    if environment not in ENVIRONMENTS:
        raise Refused(f"unknown environment; expected one of {list(ENVIRONMENTS)}")
    return f"{environment}/terraform.tfstate"


# --- minimal S3 (SigV4) for checks the backend does not do: bucket reachable, state encrypted ----------

def _sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode(), hashlib.sha256).digest()


def sigv4_headers(method: str, url: str, credentials: tuple[str, str], payload: bytes = b"",
                  extra: Optional[dict[str, str]] = None, now: Optional[datetime.datetime] = None) -> dict[str, str]:
    """AWS Signature Version 4 headers for R2 (region auto, service s3). Path-style URLs only."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    amz_date, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    parts = urllib.parse.urlsplit(url)
    payload_hash = hashlib.sha256(payload).hexdigest()
    headers = {"host": parts.netloc, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date}
    headers.update({name.lower(): value for name, value in (extra or {}).items()})
    query = "&".join(
        f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}"
        for k, v in sorted(urllib.parse.parse_qsl(parts.query, keep_blank_values=True))
    )
    signed = ";".join(sorted(headers))
    canonical = "\n".join([
        method,
        urllib.parse.quote(parts.path or "/", safe="/-_.~"),
        query,
        "".join(f"{name}:{headers[name].strip()}\n" for name in sorted(headers)),
        signed,
        payload_hash,
    ])
    scope = f"{day}/auto/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = _sign(_sign(_sign(_sign(("AWS4" + credentials[1]).encode(), day), "auto"), "s3"), "aws4_request")
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    headers["authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={credentials[0]}/{scope}, SignedHeaders={signed}, Signature={signature}"
    )
    del headers["host"]
    return headers


def s3_request(method: str, base: str, path: str, credentials: tuple[str, str], payload: bytes = b"",
               extra: Optional[dict[str, str]] = None, query: Optional[dict[str, str]] = None) -> tuple[int, bytes]:
    """(HTTP status, body). Never raises on an HTTP status; the body is returned to the caller, not printed."""
    url = base.rstrip("/") + "/" + urllib.parse.quote(path.lstrip("/"), safe="/-_.~")
    if query:
        url += "?" + urllib.parse.urlencode(sorted(query.items()), quote_via=urllib.parse.quote, safe="-_.~")
    headers = sigv4_headers(method, url, credentials, payload, extra)
    request = urllib.request.Request(url, data=payload if method in ("PUT", "POST") else None, method=method,
                                     headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    except (urllib.error.URLError, OSError):
        raise Refused("the R2 S3 endpoint is unreachable") from None


def encrypted_state(body: bytes) -> bool:
    """True if a state object is OpenTofu-encrypted (meta + encrypted_data, no plaintext resources)."""
    try:
        document = json.loads(body)
    except ValueError:
        return False
    return (isinstance(document, dict) and "encrypted_data" in document and "meta" in document
            and "resources" not in document and "outputs" not in document)


# --- tofu ----------------------------------------------------------------------------------------------

def child_env(base: dict[str, str], *, token: str, passphrase_value: str, credentials: tuple[str, str],
              s3_endpoint: str, data_dir: Path) -> dict[str, str]:
    env = {name: value for name, value in base.items() if name in KEPT or not name.startswith(STRIPPED_PREFIXES)}
    env.pop(PASSPHRASE_ENV, None)
    env.pop(VALUES_ENV, None)
    env.pop(FALLBACK_KEY_ID, None)
    env.pop(FALLBACK_SECRET, None)
    env.update({
        "CLOUDFLARE_API_TOKEN": token,
        PASSPHRASE_VAR: passphrase_value,
        "AWS_ACCESS_KEY_ID": credentials[0],
        "AWS_SECRET_ACCESS_KEY": credentials[1],
        "AWS_ENDPOINT_URL_S3": s3_endpoint,
        "AWS_REGION": "auto",
        "TF_DATA_DIR": str(data_dir),
        "TF_IN_AUTOMATION": "1",
        "TF_INPUT": "0",
        "CHECKPOINT_DISABLE": "1",
    })
    return env


_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+")
_QUOTED = re.compile(r"\"[^\"]*\"|'[^']*'|`[^`]*`")
_LONG = re.compile(r"[A-Za-z0-9+/=_.:-]{17,}")


def sanitize(line: str) -> str:
    """An "Error:" headline without quoted text, emails, URLs, ids or long tokens; at most 160 characters."""
    line = _QUOTED.sub("<…>", line)
    line = _EMAIL.sub("<…>", line)
    line = _LONG.sub("<…>", line)
    line = "".join(c if 32 <= ord(c) < 127 or c == "…" else "?" for c in line)
    return line[:160]


def error_headlines(text: str) -> list[str]:
    found: list[str] = []
    for raw in text.splitlines():
        line = raw.strip().lstrip("│╷╵ ").strip()
        if line.startswith("Error: "):
            clean = sanitize(line)
            if clean not in found:
                found.append(clean)
    return found[:5]


class Tofu:
    """Runs tofu in infra/ with output to a private log; `show` is the only call whose output is read."""

    def __init__(self, env: dict[str, str], log: Path, binary: str = "tofu"):
        self.env, self.log, self.binary = env, log, binary

    def run(self, *args: str) -> int:
        with open(self.log, "a") as handle:
            handle.write(f"\n$ tofu {args[0]}\n")
            handle.flush()
            try:
                return subprocess.run([self.binary, *args], cwd=INFRA, env=self.env, stdout=handle,
                                      stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL).returncode
            except OSError:
                raise Refused("cannot run tofu; install OpenTofu 1.12") from None

    def show_json(self, plan: Path) -> Any:
        try:
            result = subprocess.run([self.binary, "show", "-json", "-no-color", str(plan)], cwd=INFRA, env=self.env,
                                    capture_output=True, stdin=subprocess.DEVNULL)
        except OSError:
            raise Refused("cannot run tofu; install OpenTofu 1.12") from None
        if result.returncode != 0:
            with open(self.log, "ab") as handle:
                handle.write(b"\n$ tofu show\n" + result.stderr)
            raise Refused("tofu show failed")
        try:
            return json.loads(result.stdout)
        except ValueError:
            raise Refused("tofu show did not return JSON") from None

    def headlines(self) -> list[str]:
        try:
            return error_headlines(self.log.read_text(errors="replace"))
        except OSError:
            return []

    def init(self, environment: str) -> None:
        code = self.run("init", "-input=false", "-no-color", "-reconfigure", "-lockfile=readonly",
                        f"-backend-config=key={state_key(environment)}")
        if code != 0:
            raise Refused("tofu init failed")

    def plan(self, values: Path, out: Path) -> int:
        """tofu plan -detailed-exitcode: 0 no changes, 2 changes; anything else raises."""
        code = self.run("plan", "-input=false", "-no-color", f"-var-file={values}", f"-out={out}", "-detailed-exitcode")
        if code not in (0, 2):
            raise Refused("tofu plan failed")
        return code

    def apply(self, plan: Path) -> None:
        if self.run("apply", "-input=false", "-no-color", str(plan)) != 0:
            raise Refused("tofu apply failed")

    def refresh_only_apply(self, values: Path) -> None:
        """Re-reads every object and writes the state again (Cloudflare is only read). Used to re-encrypt."""
        if self.run("apply", "-input=false", "-no-color", "-refresh-only", "-auto-approve", f"-var-file={values}") != 0:
            raise Refused("tofu apply -refresh-only failed")


def load_summary_module():
    spec = importlib.util.spec_from_file_location("infra_plan_summary", SUMMARY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def summarize(plan_json: Any) -> tuple[dict, str]:
    """(summary, rendered markdown): addresses and actions only (tools/infra-plan-summary)."""
    module = load_summary_module()
    try:
        summary = module.summarize(plan_json, module.Keys(module.config_keys(str(INFRA))))
    except module.NotAPlan:
        raise Refused("tofu show output is not a plan") from None
    return summary, module.render(summary, show_all=False)


def counts(summary: dict) -> dict[str, int]:
    result: dict[str, int] = {}
    for word, _ in summary["rows"]:
        result[word] = result.get(word, 0) + 1
    return result


def destructive(summary: dict) -> bool:
    return load_summary_module().destructive(summary)


def planned_outputs(plan_json: Any) -> dict[str, Any]:
    """The values the outputs will have after an apply (planned_values.outputs), by output name."""
    outputs = ((plan_json or {}).get("planned_values") or {}).get("outputs") or {}
    return {name: entry.get("value") for name, entry in outputs.items() if isinstance(entry, dict)}


def read_wrangler_configs(repo: Path = REPO) -> dict[str, dict]:
    """The production wrangler.toml files, parsed, by path. tomllib is required (Python 3.11+)."""
    configs = {}
    for relative in WRANGLER_CONFIGS:
        try:
            with open(repo / relative, "rb") as handle:
                configs[relative] = tomllib.load(handle)
        except (OSError, ValueError):
            raise Refused(f"cannot read {relative}") from None
    return configs


def output_problems(outputs: dict[str, Any], configs: dict[str, dict]) -> list[str]:
    """Every place where a wrangler.toml and the planned outputs disagree. Paths and field names only, no value."""
    problems = []
    missing = [name for name in OUTPUTS if name not in outputs]
    if missing:
        return [f"the plan has no output {name}" for name in missing]
    aud, d1, r2 = outputs["access_aud"], outputs["d1_database_ids"], outputs["r2_bucket_names"]
    if not (isinstance(aud, dict) and isinstance(d1, dict) and isinstance(r2, list)):
        return ["an output is not known before the apply (a replaced object?)"]
    for path, config in configs.items():
        name = config.get("name")
        audience = (config.get("vars") or {}).get("ACCESS_AUDIENCE")
        if audience is not None and aud.get(name) != audience:
            problems.append(f"{path}: vars.ACCESS_AUDIENCE differs from access_aud for its Worker")
        for database in config.get("d1_databases") or []:
            if d1.get(database.get("database_name")) != database.get("database_id"):
                problems.append(f"{path}: a d1_databases database_id differs from d1_database_ids")
        for bucket in config.get("r2_buckets") or []:
            if bucket.get("bucket_name") not in r2:
                problems.append(f"{path}: an r2_buckets bucket_name is not in r2_bucket_names")
    return problems


def check_outputs(plan_json: Any, env: dict[str, str], repo: Path = REPO) -> list[str]:
    """output_problems() for this plan, or [] with a notice when tomllib is missing outside a runner."""
    if tomllib is None:
        if on_actions_runner(env):
            raise Refused("the wrangler.toml check needs Python 3.11+ (tomllib) on the runner")
        print("infra_state: wrangler.toml check skipped: it needs Python 3.11+ (tomllib)", file=sys.stderr)
        return []
    return output_problems(planned_outputs(plan_json), read_wrangler_configs(repo))


def drift_exit(summary: dict) -> int:
    """The plan's verdict for the drift check: destructive > any planned action or output change > clean."""
    if destructive(summary):
        return EXIT_DESTRUCTIVE
    if any(word != "no-op" for word, _ in summary["rows"]) or summary["outputs"]:
        return EXIT_DRIFT
    return EXIT_OK


# --- session -------------------------------------------------------------------------------------------

class Session:
    """Everything a run needs, prepared before tofu starts: refuses early, prints no value."""

    def __init__(self, *, environment: str, values: dict[str, Any], work: Path, env: dict[str, str],
                 s3_endpoint: Optional[str] = None, fetch: Optional[Callable[[str], dict]] = None):
        self.environment = environment
        state_key(environment)
        self.work = work
        self.passphrase = passphrase(env)
        token = env.get("CLOUDFLARE_API_TOKEN", "")
        if not token:
            raise Refused("set CLOUDFLARE_API_TOKEN in the environment")
        self.values = values
        # Before anything can print: every value inside INFRA_TFVARS, then the derived credentials.
        mask(value_scalars(values), env)
        fetch = fetch or (lambda path: cloudflare_get(token, path))
        self.credentials = s3_credentials(env, values["account_id"], fetch)
        mask([self.credentials[0], self.credentials[1]], env)
        self.endpoint = s3_endpoint or endpoint(values["account_id"])
        require_fresh_private_dir(self.work)  # never chmods or reuses a directory this run did not create
        self.values_file = self.work / "values.tfvars.json"
        write_private(self.values_file, json.dumps(values))
        self.log = self.work / "tofu.log"
        write_private(self.log, "")
        self.tofu = Tofu(child_env(env, token=token, passphrase_value=self.passphrase,
                                   credentials=self.credentials, s3_endpoint=self.endpoint,
                                   data_dir=self.work / "tfdata"), self.log)

    def s3(self, method: str, key: str, payload: bytes = b"", extra: Optional[dict[str, str]] = None,
           query: Optional[dict[str, str]] = None):
        """One request to the state bucket (key "" is the bucket itself)."""
        path = f"{BUCKET}/{key}" if key else BUCKET
        return s3_request(method, self.endpoint, path, self.credentials, payload, extra, query=query)

    def cleanup(self) -> None:
        """Remove the values and plan files (plans are encrypted, but they hold every value once decrypted)."""
        for path in [self.values_file, *self.work.glob("*.tfplan")]:
            try:
                path.unlink()
            except OSError:
                pass

    def plan(self, name: str) -> tuple[int, dict, str]:
        code, summary, rendered, _ = self.plan_full(name)
        return code, summary, rendered

    def plan_full(self, name: str) -> tuple[int, dict, str, Any]:
        """(tofu exit code, summary, rendered summary, the plan's JSON). The JSON holds every value: it stays in
        memory and only the gates below read it."""
        out = self.work / f"{name}.tfplan"
        code = self.tofu.plan(self.values_file, out)
        plan_json = self.tofu.show_json(out)
        summary, rendered = summarize(plan_json)
        return code, summary, rendered, plan_json


def report(text: str, env: dict[str, str]) -> None:
    sys.stdout.write(text)
    sys.stdout.flush()
    summary_file = env.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with open(summary_file, "a") as handle:
            handle.write(text + "\n")


def read_values_argument(path: Optional[Path], env: dict[str, str]) -> dict[str, Any]:
    if path is not None:
        try:
            return parse_values(outside_repo(path).read_text())
        except OSError:
            raise Refused("cannot read the values file") from None
    text = env.get(VALUES_ENV, "")
    if not text:
        raise Refused(f"pass --var-file or set {VALUES_ENV}")
    return parse_values(text)


def command_plan(args: argparse.Namespace, env: dict[str, str]) -> int:
    values = read_values_argument(args.var_file, env)
    work = new_work_dir(args.work_dir, env)  # created here, so the finally below may remove it
    session = None
    try:
        session = Session(environment=args.environment, values=values, work=work, env=env)
        session.tofu.init(args.environment)
        tofu_code, summary, rendered, plan_json = session.plan_full("drift")
        report(rendered, env)
        problems = check_outputs(plan_json, env)
        verdict = drift_exit(summary)
        if verdict == EXIT_OK and tofu_code != 0:
            verdict = EXIT_DRIFT  # tofu saw a change the summary does not classify: never call it clean
        for problem in problems:
            print(f"infra_state: {problem}", file=sys.stderr)
        if problems and verdict != EXIT_DESTRUCTIVE:
            verdict = EXIT_MISMATCH
        if verdict == EXIT_DESTRUCTIVE:
            print("infra_state: the plan deletes, replaces or forgets a resource", file=sys.stderr)
        elif verdict == EXIT_MISMATCH:
            print("infra_state: the outputs and the apps' wrangler.toml files differ", file=sys.stderr)
        elif verdict == EXIT_DRIFT:
            print("infra_state: the plan has actions: Cloudflare and infra/ differ (drift)", file=sys.stderr)
        if verdict in (EXIT_DRIFT, EXIT_DESTRUCTIVE):
            # Counts and the plan fingerprint (addresses only): the expect input that applies exactly this plan. A
            # reviewer compares it with the line they expected from the address table; never copy a differing line.
            print(f"infra_state: \"Infra apply\" expect for this plan: "
                  f"{format_expect(plan_counts(summary), plan_fingerprint(summary))}")
        if verdict == EXIT_OK:
            print("infra_state: no changes")
        return verdict
    except Refused as error:
        print(f"infra_state: {error}", file=sys.stderr)
        if session is not None:
            for line in session.tofu.headlines():
                print(f"infra_state: tofu {line}", file=sys.stderr)
        return EXIT_ERROR
    finally:
        if session is not None:
            session.cleanup()  # the values and plan files go even with --keep-work-dir (which keeps the log)
        if not args.keep_work_dir:
            shutil.rmtree(work, ignore_errors=True)


# --- apply (README.md "Apply") ---------------------------------------------------------------------------

class Destructive(Refused):
    """The plan deletes, replaces or forgets and the dispatch did not confirm it: nothing is applied."""


_COUNT = re.compile(r"(import(?:\+[a-z-]+)?|create|update|replace|delete|forget|read|outputs)=([0-9]+)")
_FINGERPRINT = re.compile(rf"[0-9a-f]{{{FINGERPRINT_DIGITS}}}")


def parse_expect(text: str) -> tuple[dict[str, int], Optional[str]]:
    """`import=5,outputs=3@<fingerprint>` -> ({"import": 5, "outputs": 3}, "<fingerprint>"); `none` -> ({}, None).

    Counts are separated by commas or spaces, zeros dropped. Any action needs the plan fingerprint that the reviewed
    "Infra drift" run printed after `@`: it binds the dispatch to that exact list of addresses and actions."""
    text = text.strip()
    if not text:
        raise Refused(f"state the expected actions with --expect or {EXPECT_ENV} (for example "
                      "import=5,outputs=3@<fingerprint>, or none), as reviewed in an \"Infra drift\" run")
    if text == "none":
        return {}, None
    counts_text, _, fingerprint = text.partition("@")
    expected: dict[str, int] = {}
    for item in re.split(r"[,\s]+", counts_text.strip()):
        match = _COUNT.fullmatch(item)
        if not match or match.group(1) in expected:
            raise Refused("the expected actions are not word=count pairs of plan action words (or none)")
        if int(match.group(2)):
            expected[match.group(1)] = int(match.group(2))
    fingerprint = fingerprint.strip()
    if not expected:
        raise Refused("the expected actions are all zero; dispatch with none instead")
    if not _FINGERPRINT.fullmatch(fingerprint):
        raise Refused(f"the expected actions need the plan fingerprint after @ ({FINGERPRINT_DIGITS} hex digits), as "
                      "the reviewed \"Infra drift\" run printed it")
    return expected, fingerprint


def plan_counts(summary: dict) -> dict[str, int]:
    """The plan's actions as parse_expect() spells them: every action word but no-op, and the output changes."""
    found = {word: n for word, n in counts(summary).items() if word != "no-op"}
    if summary["outputs"]:
        found["outputs"] = len(summary["outputs"])
    return found


def plan_fingerprint(summary: dict) -> str:
    """The first FINGERPRINT_DIGITS hex digits of SHA-256 over the plan's sorted (action, address) rows, no-op rows
    included, and its output changes. Built from the redacted summary only (addresses and action words, already
    public), never from a value; the "changed outside OpenTofu" section is left out because it moves by itself."""
    document = {"resources": sorted([word, address] for word, address in summary["rows"]),
                "outputs": sorted([word, name] for word, name in summary["outputs"])}
    digest = hashlib.sha256(json.dumps(document, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
    return digest[:FINGERPRINT_DIGITS]


def format_expect(found: dict[str, int], fingerprint: Optional[str] = None) -> str:
    """plan_counts() and plan_fingerprint() as the expect text "Infra apply" takes (parse_expect round-trips it)."""
    if not found:
        return "none"
    text = ",".join(f"{word}={n}" for word, n in sorted(found.items()))
    return f"{text}@{fingerprint}" if fingerprint else text


def _type_name(value: Any) -> str:
    return value if isinstance(value, str) and re.fullmatch(r"[a-z0-9_]{1,80}", value) else "<unexpected type>"


def type_violations(plan_json: Any) -> list[str]:
    """Types (and data sources) outside ALLOWED_TYPES that the plan would act on. Type names only."""
    found = []
    for item in (plan_json or {}).get("resource_changes") or []:
        change = item.get("change") or {}
        if change.get("actions") in (["no-op"], []) and not change.get("importing"):
            continue
        if item.get("mode") != "managed":
            found.append(f"a {_type_name(item.get('type'))} data source")
        elif item.get("type") not in ALLOWED_TYPES:
            found.append(_type_name(item.get("type")))
    return sorted(set(found))


def _base_address(value: Any) -> str:
    """A resource address without its instance key (`a.b["k"]` -> `a.b`)."""
    return value.split("[", 1)[0] if isinstance(value, str) else ""


def _object_ids(change: dict) -> set[str]:
    """The object ids a change names: before.id, after.id and the import id's last segment."""
    found = set()
    for side in ("before", "after"):
        value = change.get(side)
        if isinstance(value, dict) and isinstance(value.get("id"), str):
            found.add(value["id"])
    importing = change.get("importing")
    if isinstance(importing, dict) and isinstance(importing.get("id"), str):
        found.add(importing["id"].rsplit("/", 1)[-1])
    return found


def frozen_violations(plan_json: Any) -> list[str]:
    """FROZEN objects the plan would write to: any change with an action (anything but a no-op, a plain import or a
    pure move) whose address or previous address is a FROZEN address (instance keys ignored) or whose object id is a
    FROZEN id. Returns the FROZEN addresses only (public), never the planned address or an id."""
    by_id = {object_id: address for address, object_id in FROZEN_OBJECTS.items()}
    found = set()
    for item in (plan_json or {}).get("resource_changes") or []:
        change = item.get("change") or {}
        if change.get("actions") in (["no-op"], []):
            continue
        for address in (item.get("address"), item.get("previous_address")):
            if _base_address(address) in FROZEN:
                found.add(_base_address(address))
        found.update(by_id[object_id] for object_id in _object_ids(change) if object_id in by_id)
    return sorted(found)


def apply_gate(summary: dict, plan_json: Any, expected: dict[str, int], fingerprint: Optional[str],
               allow_destructive: bool, problems: list[str]) -> None:
    """Refuses (fixed messages, FROZEN addresses, type names, counts and fingerprints only) unless the plan may be
    applied: exactly the reviewed plan, and nothing a gate forbids."""
    if destructive(summary) and not allow_destructive:
        raise Destructive(f"the plan deletes, replaces or forgets a resource; dispatch with {CONFIRM_ENV} = "
                          f"{CONFIRM_PHRASE} only if that is intended")
    types = type_violations(plan_json)
    if types:
        raise Refused(f"the plan acts on types outside ALLOWED_TYPES: {types}")
    frozen = frozen_violations(plan_json)
    if frozen:
        raise Refused(f"the plan writes to a FROZEN object: {frozen}")
    if problems:
        raise Refused("the planned outputs and the apps' wrangler.toml files differ (see above)")
    found = plan_counts(summary)
    if found != expected:
        raise Refused(f"the plan's actions {dict(sorted(found.items()))} are not the expected "
                      f"{dict(sorted(expected.items()))}")
    if found and plan_fingerprint(summary) != fingerprint:
        raise Refused(f"the plan's fingerprint {plan_fingerprint(summary)} is not the reviewed {fingerprint}: main or "
                      "Cloudflare changed since that \"Infra drift\" run; review a new run before dispatching again")


def utc_now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def backup_state(session: "Session", environment: str, env: dict[str, str]) -> str:
    """Copy the (already OpenTofu-encrypted) state object to backups/<environment>/terraform.tfstate.<UTC time>[-run<id>]
    in the same private bucket, read it back and compare. Refuses a missing or unencrypted state. Returns the key."""
    status, body = session.s3("GET", state_key(environment))
    if status != 200:
        raise Refused(f"cannot read the remote state object (HTTP {status}); bootstrap it first")
    if not encrypted_state(body):
        raise Refused("the remote state object is not encrypted; refusing to copy or apply")
    stamp = utc_now().strftime("%Y%m%dT%H%M%SZ")
    run = env.get("GITHUB_RUN_ID", "")
    key = f"{BACKUP_PREFIX}/{environment}/terraform.tfstate.{stamp}" + (f"-run{run}" if run.isdigit() else "")
    # Never over an existing object. A HEAD, not If-None-Match: R2's conditional writes are unproven for this bucket
    # (versions.tf), and the concurrency group already rules out a second writer.
    status, _ = session.s3("HEAD", key)
    if status != 404:
        raise Refused(f"the state backup key is taken or unreadable (HTTP {status})")
    status, _ = session.s3("PUT", key, body)
    if status not in (200, 201):
        raise Refused(f"writing the state backup failed (HTTP {status})")
    status, copy = session.s3("GET", key)
    if status != 200 or hashlib.sha256(copy).digest() != hashlib.sha256(body).digest():
        raise Refused("the state backup does not read back identical")
    return key


_BACKUP_NAME = re.compile(r"terraform\.tfstate\.[0-9]{8}T[0-9]{6}Z(?:-run[0-9]+)?")
_LIST_KEY = re.compile(rb"<Key>([^<]*)</Key>")
_LIST_TOKEN = re.compile(rb"<NextContinuationToken>([^<]*)</NextContinuationToken>")
MAX_LIST_PAGES = 20  # 20 x 1000 keys; the backups grow by one per apply


def list_backups(session: "Session", environment: str) -> list[str]:
    """The keys under backups/<environment>/ (ListObjectsV2, keys only). A key that is not a backup name is counted
    by the caller but never printed."""
    prefix = f"{BACKUP_PREFIX}/{state_key(environment).split('/', 1)[0]}/"
    keys: list[str] = []
    token = None
    for _ in range(MAX_LIST_PAGES):
        query = {"list-type": "2", "prefix": prefix}
        if token:
            query["continuation-token"] = token
        status, body = session.s3("GET", "", query=query)
        if status != 200:
            raise Refused(f"listing the state backups failed (HTTP {status})")
        keys += [key.decode("utf-8", "replace") for key in _LIST_KEY.findall(body)]
        more = _LIST_TOKEN.search(body)
        if not more:
            return sorted(keys)
        token = more.group(1).decode()
    raise Refused("too many state backup keys to list; delete old ones first")


def backup_names(keys: list[str], environment: str) -> tuple[list[str], int]:
    """(the keys that are backup names, the number of other keys under the prefix)."""
    prefix = f"{BACKUP_PREFIX}/{environment}/"
    names = [key for key in keys if key.startswith(prefix) and _BACKUP_NAME.fullmatch(key[len(prefix):])]
    return names, len(keys) - len(names)


def command_list_backups(args: argparse.Namespace, env: dict[str, str]) -> int:
    """Print the state backups' keys (names hold a UTC time and a run id only) and their count."""
    values = read_values_argument(args.var_file, env)
    work = new_work_dir(None, env)
    session = None
    try:
        session = Session(environment=args.environment, values=values, work=work, env=env)
        names, other = backup_names(list_backups(session, args.environment), args.environment)
        for name in names:
            print(f"{BUCKET}/{name}")
        print(f"backups: {len(names)}" + (f" (and {other} other keys under the prefix, not shown)" if other else ""))
        return EXIT_OK
    except Refused as error:
        print(f"infra_state: {error}", file=sys.stderr)
        return EXIT_ERROR
    finally:
        if session is not None:
            session.cleanup()
        shutil.rmtree(work, ignore_errors=True)


def require_apply_context(env: dict[str, str]) -> None:
    """Refuses unless this is the "Infra apply" workflow, dispatched on main, on a GitHub Actions runner."""
    if not (on_actions_runner(env) and env.get("GITHUB_REF") == APPLY_REF
            and env.get("GITHUB_EVENT_NAME") == APPLY_EVENT and env.get("GITHUB_WORKFLOW") == APPLY_WORKFLOW):
        raise Refused(f"apply runs only in the \"{APPLY_WORKFLOW}\" workflow dispatched on main "
                      "(infra/README.md \"Apply\"); locally, run `plan`")


def command_apply(args: argparse.Namespace, env: dict[str, str]) -> int:
    require_apply_context(env)  # before the values, the token or a request: a local slip does nothing at all
    values = read_values_argument(args.var_file, env)
    expected, fingerprint = parse_expect(args.expect if args.expect is not None else env.get(EXPECT_ENV, ""))
    confirm = env.get(CONFIRM_ENV, "")
    if confirm not in ("", CONFIRM_PHRASE):
        raise Refused(f"{CONFIRM_ENV} must be empty or exactly {CONFIRM_PHRASE}")
    work = new_work_dir(args.work_dir, env)  # created here, so the finally below may remove it
    session = None
    try:
        session = Session(environment=args.environment, values=values, work=work, env=env)
        key = backup_state(session, args.environment, env)
        print(f"apply: encrypted state copied to {BUCKET}/{key} and read back")
        session.tofu.init(args.environment)
        tofu_code, summary, rendered, plan_json = session.plan_full("apply")
        report(rendered, env)
        apply_gate(summary, plan_json, expected, fingerprint, confirm == CONFIRM_PHRASE, check_outputs(plan_json, env))
        if not plan_counts(summary):
            if tofu_code != 0:
                raise Refused("tofu reports changes that the summary does not classify; nothing was applied")
            print("apply: nothing to apply")
            return EXIT_OK
        print("apply: every gate passed; applying exactly the saved plan")
        session.tofu.apply(work / "apply.tfplan")
        tofu_code, summary, rendered, plan_json = session.plan_full("verify")
        report(rendered, env)
        problems = check_outputs(plan_json, env)
        if tofu_code != 0 or drift_exit(summary) != EXIT_OK or problems:
            raise Refused("applied, but the plan after the apply is not \"No changes\" with matching outputs")
        print("apply: done. The plan after the apply is \"No changes\".")
        return EXIT_OK
    except Refused as error:
        print(f"infra_state: {error}", file=sys.stderr)
        if session is not None:
            for line in session.tofu.headlines():
                print(f"infra_state: tofu {line}", file=sys.stderr)
        return EXIT_DESTRUCTIVE if isinstance(error, Destructive) else EXIT_ERROR
    finally:
        if session is not None:
            session.cleanup()
        if not args.keep_work_dir:
            shutil.rmtree(work, ignore_errors=True)


def committed_key_provider(versions: Optional[Path] = None) -> str:
    """The name of the pbkdf2 key provider in versions.tf (renamed for every passphrase rotation)."""
    names = re.findall(r'key_provider\s+"pbkdf2"\s+"([a-z][a-z0-9_]*)"', (versions or INFRA / "versions.tf").read_text())
    if len(names) != 1:
        raise Refused("versions.tf must declare exactly one pbkdf2 key provider")
    return names[0]


def state_key_providers(body: bytes) -> list[str]:
    """The pbkdf2 key provider names an encrypted state object was written with (its meta keys; no secret)."""
    try:
        meta = json.loads(body).get("meta") or {}
    except (ValueError, AttributeError):
        raise Refused("the remote state object is not an encrypted state") from None
    return sorted(m.group(1) for key in meta if (m := re.fullmatch(r"key_provider\.pbkdf2\.([a-z][a-z0-9_]*)", key)))


def hcl_string(value: str) -> str:
    """A quoted HCL string literal (no interpolation) for a passphrase."""
    if any(ord(c) < 32 for c in value):
        raise Refused("the old passphrase holds a control character")
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("${", "$${").replace("%{", "%%{")
    return f'"{escaped}"'


def fallback_encryption(old_name: str, old_passphrase: str) -> str:
    """TF_ENCRYPTION for one rotation: the previous key provider (by the name the state was written with) as
    the fallback that can only DECRYPT; everything is written with the committed (new) method."""
    return (
        f'key_provider "pbkdf2" "{old_name}" {{\n  passphrase = {hcl_string(old_passphrase)}\n}}\n'
        f'method "aes_gcm" "previous" {{\n  keys = key_provider.pbkdf2.{old_name}\n}}\n'
        + "".join(
            f"{kind} {{\n  method   = method.aes_gcm.state\n  enforced = true\n"
            f"  fallback {{\n    method = method.aes_gcm.previous\n  }}\n}}\n"
            for kind in ("state", "plan")
        )
    )


def command_rotate(args: argparse.Namespace, env: dict[str, str]) -> int:
    """Re-encrypt the remote state with a new passphrase (README.md "Rotating the passphrase")."""
    values = read_values_argument(args.var_file, env)
    old = read_secret_file(args.old_passphrase_file)
    if len(old) < MIN_PASSPHRASE:
        raise Refused(f"the old passphrase must have at least {MIN_PASSPHRASE} characters")
    new_name = committed_key_provider()
    work = new_work_dir(args.work_dir, env)  # created here, so the finally below may remove it
    session = None
    try:
        session = Session(environment=args.environment, values=values, work=work, env=env)
        if session.passphrase == old:
            raise Refused("the new passphrase equals the old one")
        status, body = session.s3("GET", state_key(args.environment))
        if status != 200:
            raise Refused(f"cannot read the remote state object (HTTP {status})")
        written_with = state_key_providers(body)
        if written_with == [new_name]:
            raise Refused("the state already uses the committed key provider: rename it in versions.tf first")
        if len(written_with) != 1:
            raise Refused("the remote state names no single pbkdf2 key provider")
        print(f"rotate: {written_with[0]} -> {new_name}")
        rotating = dict(session.tofu.env, TF_ENCRYPTION=fallback_encryption(written_with[0], old))
        Tofu(rotating, session.log).init(args.environment)
        Tofu(rotating, session.log).refresh_only_apply(session.values_file)
        status, body = session.s3("GET", state_key(args.environment))
        if status != 200 or not encrypted_state(body) or state_key_providers(body) != [new_name]:
            raise Refused("the state was not re-encrypted with the committed key provider")
        session.tofu.init(args.environment)
        tofu_code, summary, rendered = session.plan("rotated")
        report(rendered, env)
        if tofu_code != 0 or drift_exit(summary) != EXIT_OK:
            raise Refused("the plan with the new passphrase alone is not \"No changes\"")
        print("rotate: done. Store the new passphrase as INFRA_STATE_PASSPHRASE now.")
        try:  # a reminder only: the rotation itself is complete
            names, _ = backup_names(list_backups(session, args.environment), args.environment)
            print(f"rotate: {len(names)} state backups are still encrypted with the old passphrase; after a suspected "
                  "leak delete them (infra/README.md \"Rotating the passphrase\").")
        except Refused:
            print("rotate: could not list the state backups; run `list-backups` and delete them after a suspected leak")
        return EXIT_OK
    except Refused as error:
        print(f"infra_state: {error}", file=sys.stderr)
        if session is not None:
            for line in session.tofu.headlines():
                print(f"infra_state: tofu {line}", file=sys.stderr)
        return EXIT_ERROR
    finally:
        if session is not None:
            session.cleanup()
        if not args.keep_work_dir:
            shutil.rmtree(work, ignore_errors=True)


def read_secret_file(path: Path) -> str:
    try:
        info = path.expanduser().stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise Refused("a passphrase file must be an owner-only regular file (chmod 600)")
        return path.expanduser().read_text().strip()
    except OSError:
        raise Refused("cannot read the passphrase file") from None


def command_values_json(args: argparse.Namespace, out=None) -> int:
    """The values as one line of JSON on stdout, for `| gh secret set INFRA_TFVARS`. Refuses a terminal."""
    out = out or sys.stdout
    if out.isatty():
        raise Refused("refusing to print values to a terminal; pipe into `gh secret set INFRA_TFVARS --env production`")
    values = read_values_argument(args.var_file, {})
    out.write(json.dumps(values, separators=(",", ":")) + "\n")
    return EXIT_OK


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    sub = parser.add_subparsers(dest="command", required=True)
    rotate = sub.add_parser("rotate-passphrase", help="re-encrypt the remote state with the new passphrase")
    rotate.add_argument("--environment", default="production", choices=ENVIRONMENTS)
    rotate.add_argument("--var-file", type=Path, required=True, help="values file outside the repository")
    rotate.add_argument("--old-passphrase-file", type=Path, required=True, help="owner-only file with the old passphrase")
    rotate.add_argument("--work-dir", type=Path, help="parent outside the repository for a new private work directory")
    rotate.add_argument("--keep-work-dir", action="store_true", help="keep the new work directory (its log)")
    values_json = sub.add_parser("values-json", help="print the values file as JSON into a pipe (never a terminal)")
    values_json.add_argument("--var-file", type=Path, required=True, help="values file outside the repository")
    apply = sub.add_parser("apply", help="back up the state, plan, gate, apply the saved plan, plan again")
    apply.add_argument("--environment", default="production", choices=ENVIRONMENTS)
    apply.add_argument("--var-file", type=Path, help=f"values file outside the repository (default: ${VALUES_ENV})")
    apply.add_argument("--expect", help="the reviewed plan's exact actions and fingerprint, e.g. "
                       f"import=5,outputs=3@<fingerprint>, or none (default: ${EXPECT_ENV})")
    apply.add_argument("--work-dir", type=Path, help="parent outside the repository for a new private work directory")
    apply.add_argument("--keep-work-dir", action="store_true", help="keep the new work directory (its log)")
    backups = sub.add_parser("list-backups", help="print the keys of the apply's state backups (keys only)")
    backups.add_argument("--environment", default="production", choices=ENVIRONMENTS)
    backups.add_argument("--var-file", type=Path, help=f"values file outside the repository (default: ${VALUES_ENV})")
    plan = sub.add_parser("plan", help="init + plan against the remote state; print the redacted summary only")
    plan.add_argument("--environment", default="production", choices=ENVIRONMENTS)
    plan.add_argument("--var-file", type=Path, help=f"values file outside the repository (default: ${VALUES_ENV})")
    plan.add_argument("--work-dir", type=Path, help="parent outside the repository for a new private work directory "
                      "(default: the temp directory); only that new directory is ever removed")
    plan.add_argument("--keep-work-dir", action="store_true", help="keep the new work directory (its log) for local debugging")
    args = parser.parse_args(argv)
    env = dict(os.environ)
    try:
        if args.command == "plan":
            return command_plan(args, env)
        if args.command == "apply":
            return command_apply(args, env)
        if args.command == "rotate-passphrase":
            return command_rotate(args, env)
        if args.command == "list-backups":
            return command_list_backups(args, env)
        if args.command == "values-json":
            return command_values_json(args)
    except Refused as error:
        print(f"infra_state: {error}", file=sys.stderr)
        return EXIT_ERROR
    return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
