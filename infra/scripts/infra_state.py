#!/usr/bin/env python3
"""Run OpenTofu for infra/ against the encrypted remote state in R2, printing only the redacted summary.

    python3 infra/scripts/infra_state.py plan --environment production [--var-file F] [--work-dir D]

Used by .github/workflows/infra.yml (daily drift plan) and by bootstrap_state.py (one-time import). It:
- refuses to run without the state passphrase (TF_VAR_state_passphrase or INFRA_STATE_PASSPHRASE): state and
  plan encryption are enforced in versions.tf and there is no unencrypted fallback;
- derives the R2 S3 credentials from CLOUDFLARE_API_TOKEN at runtime (access key id = the token's id from
  the verify endpoint, secret access key = SHA-256 of the token), masks them under GitHub Actions and passes
  them to tofu through the environment only. Fallback when derivation is not possible: INFRA_R2_ACCESS_KEY_ID
  and INFRA_R2_SECRET_ACCESS_KEY (README.md "Remote state");
- runs `tofu init` with the S3 backend and `tofu plan -detailed-exitcode -out`, sending tofu's own output to
  a 0600 log inside a private work directory outside the repository, never to the terminal;
- reads `tofu show -json` into memory (never to disk) and prints tools/infra-plan-summary's summary only.

Values come from --var-file (a tfvars file written by local_tfvars.py, or JSON) or from the INFRA_TFVARS
environment variable (the GitHub secret, JSON). `values-json --var-file F | gh secret set INFRA_TFVARS ...`
turns a local values file into that secret without showing it (it refuses to write to a terminal). Errors are fixed messages; a failed tofu step prints only
its sanitised "Error:" headlines (no quoted strings, addresses, ids or long tokens).

Exit codes: 0 no planned action; 1 error; 2 planned actions (drift); 3 a delete, replace or forget.
Standard library only, Python 3.9+. Tests: python3 -m unittest discover -s infra/tests
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
EXIT_OK, EXIT_ERROR, EXIT_DRIFT, EXIT_DESTRUCTIVE = 0, 1, 2, 3


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


def mask(values: list[str], env: dict[str, str], out=None) -> None:
    """Ask the GitHub Actions runner to mask each value in every later log line (no-op anywhere else).

    Only for values the runner does not know: the token and the passphrase come from `secrets.*`, which GitHub
    masks already; the derived access key id and secret access key are new strings."""
    if not on_actions_runner(env):
        return
    out = out or sys.stdout
    for value in values:
        if value:
            out.write(f"::add-mask::{value}\n")
    out.flush()


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
               extra: Optional[dict[str, str]] = None) -> tuple[int, bytes]:
    """(HTTP status, body). Never raises on an HTTP status; the body is returned to the caller, not printed."""
    url = base.rstrip("/") + "/" + urllib.parse.quote(path.lstrip("/"), safe="/-_.~")
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
        fetch = fetch or (lambda path: cloudflare_get(token, path))
        self.credentials = s3_credentials(env, values["account_id"], fetch)
        mask([self.credentials[0], self.credentials[1]], env)
        self.endpoint = s3_endpoint or endpoint(values["account_id"])
        self.work.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.work, 0o700)
        self.values_file = self.work / "values.tfvars.json"
        write_private(self.values_file, json.dumps(values))
        self.log = self.work / "tofu.log"
        write_private(self.log, "")
        self.tofu = Tofu(child_env(env, token=token, passphrase_value=self.passphrase,
                                   credentials=self.credentials, s3_endpoint=self.endpoint,
                                   data_dir=self.work / "tfdata"), self.log)

    def s3(self, method: str, key: str, payload: bytes = b"", extra: Optional[dict[str, str]] = None):
        """One request to the state bucket (key "" is the bucket itself)."""
        path = f"{BUCKET}/{key}" if key else BUCKET
        return s3_request(method, self.endpoint, path, self.credentials, payload, extra)

    def cleanup(self) -> None:
        """Remove the values and plan files (plans are encrypted, but they hold every value once decrypted)."""
        for path in [self.values_file, *self.work.glob("*.tfplan")]:
            try:
                path.unlink()
            except OSError:
                pass

    def plan(self, name: str) -> tuple[int, dict, str]:
        out = self.work / f"{name}.tfplan"
        code = self.tofu.plan(self.values_file, out)
        summary, rendered = summarize(self.tofu.show_json(out))
        return code, summary, rendered


def default_work_dir(env: dict[str, str]) -> Path:
    base = env.get("RUNNER_TEMP") or None
    return Path(tempfile.mkdtemp(prefix="infra-", dir=base))


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
    work = outside_repo(args.work_dir) if args.work_dir else default_work_dir(env)
    session = None
    try:
        session = Session(environment=args.environment, values=values, work=work, env=env)
        session.tofu.init(args.environment)
        tofu_code, summary, rendered = session.plan("drift")
        report(rendered, env)
        verdict = drift_exit(summary)
        if verdict == EXIT_OK and tofu_code != 0:
            verdict = EXIT_DRIFT  # tofu saw a change the summary does not classify: never call it clean
        if verdict == EXIT_DESTRUCTIVE:
            print("infra_state: the plan deletes, replaces or forgets a resource", file=sys.stderr)
        elif verdict == EXIT_DRIFT:
            print("infra_state: the plan has actions: Cloudflare and infra/ differ (drift)", file=sys.stderr)
        else:
            print("infra_state: no changes")
        return verdict
    except Refused as error:
        print(f"infra_state: {error}", file=sys.stderr)
        if session is not None:
            for line in session.tofu.headlines():
                print(f"infra_state: tofu {line}", file=sys.stderr)
        return EXIT_ERROR
    finally:
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
    work = outside_repo(args.work_dir) if args.work_dir else default_work_dir(env)
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
    rotate.add_argument("--work-dir", type=Path, help="private work directory outside the repository")
    rotate.add_argument("--keep-work-dir", action="store_true", help="keep the work directory (its log)")
    values_json = sub.add_parser("values-json", help="print the values file as JSON into a pipe (never a terminal)")
    values_json.add_argument("--var-file", type=Path, required=True, help="values file outside the repository")
    plan = sub.add_parser("plan", help="init + plan against the remote state; print the redacted summary only")
    plan.add_argument("--environment", default="production", choices=ENVIRONMENTS)
    plan.add_argument("--var-file", type=Path, help=f"values file outside the repository (default: ${VALUES_ENV})")
    plan.add_argument("--work-dir", type=Path, help="private work directory outside the repository (default: a new temp dir)")
    plan.add_argument("--keep-work-dir", action="store_true", help="keep the work directory (its log) for local debugging")
    args = parser.parse_args(argv)
    env = dict(os.environ)
    try:
        if args.command == "plan":
            return command_plan(args, env)
        if args.command == "rotate-passphrase":
            return command_rotate(args, env)
        if args.command == "values-json":
            return command_values_json(args)
    except Refused as error:
        print(f"infra_state: {error}", file=sys.stderr)
        return EXIT_ERROR
    return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
