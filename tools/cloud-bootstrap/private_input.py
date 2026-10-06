"""Owner-only local bootstrap inputs. No secret is accepted through CLI arguments."""

from __future__ import annotations

import json
import hashlib
import os
import secrets
import stat
import tempfile
from pathlib import Path


class BootstrapError(ValueError):
    """A fixed diagnostic safe for public logs."""

    def __init__(self, code: str, details: dict | None = None):
        super().__init__(code)
        self.details = details or {}


def read_document(path: Path, repository: Path):
    resolved = path.expanduser().resolve()
    if repository.resolve() == resolved or repository.resolve() in resolved.parents or path.is_symlink():
        raise BootstrapError("PRIVATE_INPUT_PATH_INVALID")
    try:
        info = resolved.stat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_size > 65536):
            raise BootstrapError("PRIVATE_INPUT_PERMISSIONS_INVALID")
        value = json.loads(resolved.read_text())
    except (OSError, ValueError) as error:
        if isinstance(error, BootstrapError):
            raise
        raise BootstrapError("PRIVATE_INPUT_UNREADABLE") from None
    return value


def read_private(path: Path, repository: Path) -> dict:
    value = read_document(path, repository)
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        raise BootstrapError("PRIVATE_INPUT_VERSION_INVALID")
    token_path = value.get("cloudflare_api_token_file")
    if token_path:
        if value.get("cloudflare_api_token") or not isinstance(token_path, str):
            raise BootstrapError("CLOUDFLARE_TOKEN_INPUT_INVALID")
        token_file = Path(token_path).expanduser()
        # API tokens use the existing normal credential file, not a second authentication flow.
        resolved = token_file.resolve()
        if repository.resolve() in resolved.parents or token_file.is_symlink():
            raise BootstrapError("CLOUDFLARE_TOKEN_PATH_INVALID")
        try:
            info = resolved.stat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 16384:
                raise BootstrapError("CLOUDFLARE_TOKEN_PERMISSIONS_INVALID")
            token = resolved.read_text().strip()
        except OSError:
            raise BootstrapError("CLOUDFLARE_TOKEN_UNREADABLE") from None
        if not token or any(c.isspace() for c in token):
            raise BootstrapError("CLOUDFLARE_TOKEN_INPUT_INVALID")
        value["cloudflare_api_token"] = token
        # Persisted prepared JSON may contain the token itself, owner-only, never both sources.
        value.pop("cloudflare_api_token_file")
    return value


def write_private(path: Path, value: dict, repository: Path) -> None:
    resolved = path.expanduser().resolve()
    if repository.resolve() == resolved or repository.resolve() in resolved.parents or path.is_symlink():
        raise BootstrapError("PRIVATE_OUTPUT_PATH_INVALID")
    resolved.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(resolved, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(value, handle, sort_keys=True)
        handle.write("\n")


def update_private(path: Path, value: dict, repository: Path) -> None:
    """Persist an initialized secret before using it; retries read this same file."""
    read_private(path, repository)
    resolved = path.expanduser().resolve()
    descriptor, temporary = tempfile.mkstemp(prefix=".bootstrap-", dir=resolved.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(value, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, resolved)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def generated_secrets(value: dict, *, generate: bool = True) -> dict:
    """Reuse persisted keys, including old application keys; generate only missing ones."""
    configured = value.get("github_secrets", {})
    if not isinstance(configured, dict) or not all(isinstance(k, str) and isinstance(v, str)
                                                for k, v in configured.items()):
        raise BootstrapError("GITHUB_SECRETS_INVALID")
    result = dict(configured)
    worker_values = value.get("worker_secrets", {})
    if not isinstance(worker_values, dict):
        raise BootstrapError("WORKER_SECRETS_INVALID")
    for worker, bindings in worker_values.items():
        if not isinstance(bindings, dict):
            raise BootstrapError("WORKER_SECRETS_INVALID")
        if not isinstance(worker, str):
            raise BootstrapError("WORKER_SECRETS_INVALID")
        prefix = {"home": "DASHBOARD", "ziyixi-website": "WEBSITE", "ziyixi-notion-publish": "WEBSITE_RELAY"}.get(
            worker, worker.upper().replace("-", "_"))
        for name, item in bindings.items():
            if name in {"CREDENTIAL_KEY", "CSRF_SIGNING_KEY", "BACKUP_TOKEN", "BACKUP_RECEIPT_KEY", "REPORT_HMAC_KEY",
                        "CF_ANALYTICS_TOKEN", "RECEIVE_ADDRESS", "TODOIST_DEFAULT_PROJECT_ID", "TODOIST_OPS_PROJECT_ID", "TODOIST_REVIEW_PROJECT_ID"}:
                source = ("TODOFY" if worker == "todofy-core" else prefix) + "_" + name
                if source in result and result[source] != item:
                    raise BootstrapError("WORKER_SECRET_CONSUMER_MISMATCH")
                result.setdefault(source, item)
    previous = value.get("vps", {})
    if not isinstance(previous, dict):
        raise BootstrapError("VPS_PRIVATE_INPUT_INVALID")
    for field in ("newsletter_env", "trigger_env", "platform_env"):
        existing = previous.get(field, {})
        if not isinstance(existing, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in existing.items()):
            raise BootstrapError("VPS_PRIVATE_INPUT_INVALID")
        for name in ("PLATFORM_DEPLOY_TOKEN", "NEWSLETTER_EDITOR_TOKEN", "NEWSLETTER_SEND_TOKEN", "NEWSLETTER_MONITOR_TOKEN"):
            if name in existing:
                result.setdefault(name, existing[name])
    if previous.get("fleet_key"):
        result.setdefault("FLEET_REPORT_HMAC_KEY", previous["fleet_key"])
    if generate:
        integration = value.setdefault("integration_credentials", {})
        if not isinstance(integration, dict):
            raise BootstrapError("INTEGRATION_CREDENTIALS_INVALID")
        integration.setdefault("mail_webhook_token", secrets.token_urlsafe(32))
        integration.setdefault("report_user", "newsletter")
        integration.setdefault("report_password", secrets.token_urlsafe(32))
        if any(not isinstance(item, str) or not item for item in integration.values()):
            raise BootstrapError("INTEGRATION_CREDENTIALS_INVALID")
        result.setdefault("TODOFY_MAIL_WEBHOOK_TOKEN_SHA256", hashlib.sha256(integration["mail_webhook_token"].encode()).hexdigest())
        result.setdefault("TODOFY_REPORT_BASIC_AUTH_SHA256", hashlib.sha256(
            (integration["report_user"] + ":" + integration["report_password"]).encode()).hexdigest())
    for name in ("PLATFORM_DEPLOY_TOKEN", "NEWSLETTER_EDITOR_TOKEN", "NEWSLETTER_SEND_TOKEN",
                 "NEWSLETTER_MONITOR_TOKEN", "MAIL_HERO_BACKUP_TOKEN"):
        if generate and not result.get(name):
            result[name] = secrets.token_urlsafe(32)
    for name in ("FLEET_REPORT_HMAC_KEY", "MAIL_HERO_CREDENTIAL_KEY", "MAIL_HERO_BACKUP_RECEIPT_KEY",
                 "TODOFY_CSRF_SIGNING_KEY", "DASHBOARD_CSRF_SIGNING_KEY", "FLOWDAY_CSRF_SIGNING_KEY",
                 "FLOWDAY_CREDENTIAL_KEY", "LINKS_CSRF_SIGNING_KEY", "WATCH_CSRF_SIGNING_KEY"):
        if generate and not result.get(name):
            result[name] = secrets.token_hex(32)
    owner = value.get("infra_values", {}).get("access_owner_emails", [])
    if generate and isinstance(owner, list) and owner:
        for prefix in ("DASHBOARD", "FLEET", "MAIL_HERO", "TODOFY"):
            result.setdefault(prefix + "_ACCESS_OWNER", owner[0])
            if len(owner) > 1:
                result.setdefault(prefix + "_ACCESS_OWNER_ALIASES", ",".join(owner[1:]))
    receive = value.get("infra_values", {}).get("mail_receive_address")
    if generate and receive:
        if result.get("MAIL_HERO_RECEIVE_ADDRESS", receive) != receive:
            raise BootstrapError("RECEIVE_ADDRESS_CONSUMER_MISMATCH")
        result.setdefault("MAIL_HERO_RECEIVE_ADDRESS", receive)
    if value.get("cloudflare_api_token"):
        result["CF_API_TOKEN"] = value["cloudflare_api_token"]
    if value.get("infra_state_passphrase"):
        result["INFRA_STATE_PASSPHRASE"] = value["infra_state_passphrase"]
    if value.get("infra_values"):
        result["INFRA_TFVARS"] = json.dumps(value["infra_values"], separators=(",", ":"))
    return result


def vps_credentials(value: dict, configured: dict[str, str], connector: str) -> dict:
    previous = value.get("vps", {})
    if not isinstance(previous, dict):
        raise BootstrapError("VPS_PRIVATE_INPUT_INVALID")
    required = {"PLATFORM_DEPLOY_TOKEN", "NEWSLETTER_EDITOR_TOKEN", "NEWSLETTER_SEND_TOKEN", "NEWSLETTER_MONITOR_TOKEN", "FLEET_REPORT_HMAC_KEY"}
    if required - set(configured):
        raise BootstrapError("VPS_EXISTING_KEYS_REQUIRED")
    newsletter = dict(previous.get("newsletter_env", {}))
    integration = value.get("integration_credentials", {})
    if integration:
        newsletter.setdefault("TODO_API_USER", integration["report_user"])
        newsletter.setdefault("TODO_API_PASSWORD", integration["report_password"])
    for variable in ("NEWSLETTER_EDITOR_TOKEN", "NEWSLETTER_SEND_TOKEN", "NEWSLETTER_MONITOR_TOKEN"):
        newsletter.setdefault(variable, configured[variable])
        if newsletter[variable] != configured[variable]:
            raise BootstrapError("VPS_SECRET_CONSUMER_MISMATCH")
    trigger = {**previous.get("trigger_env", {}),
               "NEWSLETTER_EDITOR_TOKEN": newsletter["NEWSLETTER_EDITOR_TOKEN"],
               "NEWSLETTER_SEND_TOKEN": newsletter["NEWSLETTER_SEND_TOKEN"]}
    platform = dict(previous.get("platform_env", {}))
    platform.setdefault("PLATFORM_DEPLOY_TOKEN", configured["PLATFORM_DEPLOY_TOKEN"])
    fleet_key = previous.get("fleet_key", configured["FLEET_REPORT_HMAC_KEY"])
    if platform["PLATFORM_DEPLOY_TOKEN"] != configured["PLATFORM_DEPLOY_TOKEN"] or fleet_key != configured["FLEET_REPORT_HMAC_KEY"]:
        raise BootstrapError("VPS_SECRET_CONSUMER_MISMATCH")
    return {"schema_version": 1, "newsletter_env": newsletter, "trigger_env": trigger,
            "platform_env": platform, "fleet_key": fleet_key,
            "connector_token": connector,
            "old_paths": previous.get("old_paths", {})}
