"""Strict, bounded bootstrap inputs; diagnostics never contain a value or secret."""

import hashlib
import json
import os
import re
import stat
from pathlib import Path


class BootstrapError(RuntimeError):
    """A fixed safe error code, without paths, credentials or upstream output."""


def require(condition, code):
    if not condition:
        raise BootstrapError(code)


def read_json(path, limit=262144, *, private=False):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), "INPUT_FILE_INVALID")
    attributes = path.stat()
    require(attributes.st_size <= limit, "INPUT_FILE_TOO_LARGE")
    if private:
        owners = {0, os.getuid()}
        sudo_uid = os.environ.get("SUDO_UID", "")
        if sudo_uid.isdigit():
            owners.add(int(sudo_uid))
        require(
            attributes.st_uid in owners
            and stat.S_IMODE(attributes.st_mode) & 0o077 == 0,
            "CREDENTIAL_FILE_NOT_PRIVATE",
        )
    try:
        value = json.loads(path.read_text())
    except (OSError, UnicodeError, ValueError):
        raise BootstrapError("INPUT_JSON_INVALID") from None
    require(isinstance(value, dict), "INPUT_JSON_INVALID")
    return value


def checksum(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_bundle(directory):
    directory = Path(directory)
    value = read_json(directory / "manifest.json")
    require(
        set(value) == {"schema_version", "source_sha", "profile", "images", "files"},
        "BUNDLE_FIELDS_INVALID",
    )
    require(
        value["schema_version"] == 1 and type(value["schema_version"]) is int,
        "BUNDLE_VERSION_INVALID",
    )
    require(
        isinstance(value["source_sha"], str)
        and re.fullmatch(r"[0-9a-f]{40}", value["source_sha"]),
        "BUNDLE_SHA_INVALID",
    )
    profile = value["profile"]
    require(
        isinstance(profile, dict)
        and set(profile)
        == {
            "namespace",
            "state_root",
            "observer_node_key",
            "fleet_host",
            "runtime_host",
            "repository",
        },
        "BUNDLE_PROFILE_INVALID",
    )
    for name in ("namespace", "observer_node_key"):
        require(
            isinstance(profile[name], str)
            and re.fullmatch(r"[a-z][a-z0-9-]{0,62}", profile[name]),
            "BUNDLE_PROFILE_INVALID",
        )
    require(
        isinstance(profile["state_root"], str)
        and re.fullmatch(r"/(srv|var/lib)/[a-z][a-z0-9-]{0,62}", profile["state_root"]),
        "BUNDLE_PROFILE_INVALID",
    )
    for name in ("fleet_host", "runtime_host"):
        require(
            isinstance(profile[name], str)
            and re.fullmatch(r"[a-z0-9.-]{3,253}", profile[name]),
            "BUNDLE_PROFILE_INVALID",
        )
    require(
        isinstance(profile["repository"], str)
        and re.fullmatch(r"[a-z0-9-]+/[a-z0-9_.-]+", profile["repository"]),
        "BUNDLE_PROFILE_INVALID",
    )
    files = value["files"]
    require(isinstance(files, dict) and 10 <= len(files) <= 24, "BUNDLE_FILES_INVALID")
    for relative, expected in files.items():
        require(
            isinstance(relative, str)
            and re.fullmatch(r"(?:installer/|units/)?[a-z0-9_.-]+", relative),
            "BUNDLE_FILES_INVALID",
        )
        require(
            isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected),
            "BUNDLE_FILES_INVALID",
        )
        path = directory / relative
        require(
            path.is_file() and not path.is_symlink() and not path.parent.is_symlink(),
            "BUNDLE_FILE_INVALID",
        )
        require(
            path.stat().st_size <= 16777216 and checksum(path) == expected,
            "BUNDLE_HASH_MISMATCH",
        )
    required = {
        "foundation.json",
        "runtime.json",
        "versions.json",
        "allowedkeys.json",
        "units/k3s.service",
        "units/k3s-config.yaml",
        "units/cloudflared-platform.service",
        "units/firewall.v4",
        "units/firewall.v6",
    }
    require(required <= set(files), "BUNDLE_FILES_MISSING")
    versions = read_json(directory / "versions.json")
    require(
        type(versions.get("version")) is int and versions["version"] == 1,
        "VERSIONS_INVALID",
    )
    pinned = versions.get("k3s", {})
    require(set(pinned) == {"version", "linux_amd64_sha256"}, "VERSIONS_INVALID")
    require(
        re.fullmatch(
            r"v1\.[0-9]{1,2}\.[0-9]{1,2}\+k3s[0-9]+", pinned.get("version", "")
        ),
        "VERSIONS_INVALID",
    )
    require(
        re.fullmatch(r"[0-9a-f]{64}", pinned.get("linux_amd64_sha256", "")),
        "VERSIONS_INVALID",
    )
    return value


def credentials(path, allowed):
    value = read_json(path, private=True)
    require(
        set(value)
        == {
            "schema_version",
            "newsletter_env",
            "trigger_env",
            "platform_env",
            "fleet_key",
            "connector_token",
            "old_paths",
        },
        "CREDENTIAL_FIELDS_INVALID",
    )
    require(
        type(value["schema_version"]) is int and value["schema_version"] == 1,
        "CREDENTIAL_VERSION_INVALID",
    )
    for field, application in (
        ("newsletter_env", "newsletter"),
        ("trigger_env", "trigger"),
        ("platform_env", "platform"),
    ):
        variables = value[field]
        require(
            isinstance(variables, dict) and set(variables) <= set(allowed[application]),
            "CREDENTIAL_ENV_INVALID",
        )
        for name, item in variables.items():
            require(
                name
                not in {"PATH", "HOME", "PYTHONPATH", "PYTHONHOME", "OPENAI_API_KEY"}
                and not name.startswith("LD_")
                and name not in set(allowed["controlled"])
                and isinstance(item, str)
                and len(item) <= 16384
                and "\x00" not in item,
                "CREDENTIAL_ENV_INVALID",
            )
    token = value["platform_env"].get("PLATFORM_DEPLOY_TOKEN", "")
    monitor = value["newsletter_env"].get("NEWSLETTER_MONITOR_TOKEN", "")
    require(
        32 <= len(token) <= 512 and not any(c.isspace() for c in token),
        "PLATFORM_CREDENTIAL_INVALID",
    )
    require(
        32 <= len(monitor) <= 512 and not any(c.isspace() for c in monitor),
        "MONITOR_CREDENTIAL_INVALID",
    )
    require(
        monitor != token
        and monitor
        not in {
            value["newsletter_env"].get("NEWSLETTER_EDITOR_TOKEN"),
            value["newsletter_env"].get("NEWSLETTER_SEND_TOKEN"),
        },
        "MONITOR_IDENTITY_NOT_DISTINCT",
    )
    send = value["newsletter_env"].get("NEWSLETTER_SEND_TOKEN", "")
    require(
        32 <= len(send) <= 512 and not any(c.isspace() for c in send),
        "NEWSLETTER_SEND_CREDENTIAL_INVALID",
    )
    editor = value["newsletter_env"].get("NEWSLETTER_EDITOR_TOKEN", "")
    require(
        24 <= len(editor) <= 512 and not any(c.isspace() for c in editor),
        "NEWSLETTER_EDITOR_CREDENTIAL_INVALID",
    )
    require(editor != send, "NEWSLETTER_EDITOR_IDENTITY_NOT_DISTINCT")
    require(token != send, "PLATFORM_IDENTITY_NOT_DISTINCT")
    require(
        value["trigger_env"].get("NEWSLETTER_SEND_TOKEN") == send
        and value["trigger_env"].get("NEWSLETTER_EDITOR_TOKEN")
        == value["newsletter_env"].get("NEWSLETTER_EDITOR_TOKEN"),
        "TRIGGER_CREDENTIAL_MISMATCH",
    )
    require(
        isinstance(value["fleet_key"], str)
        and re.fullmatch(r"[0-9a-fA-F]{64}", value["fleet_key"]),
        "FLEET_CREDENTIAL_INVALID",
    )
    require(
        isinstance(value["connector_token"], str)
        and 24 <= len(value["connector_token"]) <= 16384
        and not any(c.isspace() for c in value["connector_token"]),
        "CONNECTOR_CREDENTIAL_INVALID",
    )
    require(
        isinstance(value["old_paths"], dict)
        and set(value["old_paths"]) <= {"data", "auth", "config"},
        "OLD_PATHS_INVALID",
    )
    for old_path in value["old_paths"].values():
        require(
            isinstance(old_path, str)
            and old_path.startswith(("/srv/", "/opt/", "/var/lib/", "/home/"))
            and not {"..", ".ssh", ".gnupg"} & set(Path(old_path).parts),
            "OLD_PATHS_INVALID",
        )
    return value
