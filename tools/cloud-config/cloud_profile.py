"""Strict public deployment profiles; no credentials, network calls or implicit env."""

from __future__ import annotations

import ipaddress
import re
import tomllib
from pathlib import Path


class ProfileError(ValueError):
    """Only a field or filename is safe to include in a public diagnostic."""


def require(condition: bool, field: str) -> None:
    if not condition:
        raise ProfileError(f"Invalid cloud configuration field: {field}")


def read_public(path: Path) -> dict:
    require(path.is_file() and not path.is_symlink(), path.name)
    require(not any(parent.is_symlink() for parent in path.parents), path.name)
    require(path.stat().st_size <= 65536, path.name)
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as error:
        raise ProfileError(f"Cannot read public configuration: {path.name}") from error


def fields(value: object, expected: set[str], field: str, optional: set[str] | None = None) -> dict:
    require(isinstance(value, dict), field)
    require(expected <= set(value) <= expected | (optional or set()), field)
    return value


def hostname(value: object, field: str) -> str:
    require(isinstance(value, str) and len(value) <= 253, field)
    require(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+", value) is not None, field)
    try:
        ipaddress.ip_address(value)
    except ValueError:
        pass
    else:
        require(False, field)
    require(value.rsplit(".", 1)[-1].isalpha(), field)
    return value


def load_profile(root: Path) -> dict:
    value = fields(read_public(root / "config/cloud.toml"),
                   {"version", "zone", "repository", "access_issuer", "platform_hostname", "vps"}, "cloud")
    require(type(value["version"]) is int and value["version"] == 1, "cloud.version")
    zone = hostname(value["zone"], "cloud.zone")
    platform = hostname(value["platform_hostname"], "cloud.platform_hostname")
    require(platform.endswith("." + zone), "cloud.platform_hostname")
    require(isinstance(value["repository"], str) and re.fullmatch(
        r"[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?/[a-z0-9][a-z0-9_.-]{0,99}", value["repository"]) is not None,
        "cloud.repository")
    require(isinstance(value["access_issuer"], str) and re.fullmatch(
        r"https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com", value["access_issuer"]) is not None,
        "cloud.access_issuer")
    vps = fields(value["vps"], {"platform_runtime_host", "namespace", "state_root", "observer_node_key"}, "cloud.vps")
    runtime_host = hostname(vps["platform_runtime_host"], "cloud.vps.platform_runtime_host")
    require(runtime_host.endswith("." + zone) and runtime_host != platform,
            "cloud.vps.platform_runtime_host")
    for key in ("namespace", "observer_node_key"):
        require(isinstance(vps[key], str) and re.fullmatch(r"[a-z][a-z0-9-]{0,62}", vps[key]) is not None,
                "cloud.vps." + key)
    require(isinstance(vps["state_root"], str) and re.fullmatch(r"/(?:srv|var/lib)/[a-z][a-z0-9-]{0,62}",
                                                              vps["state_root"]) is not None,
            "cloud.vps.state_root")
    return value


def identifiers(value: object, field: str, pattern: str) -> dict[str, str]:
    require(isinstance(value, dict), field)
    for name, identifier in value.items():
        require(re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name) is not None, field)
        require(isinstance(identifier, str) and re.fullmatch(pattern, identifier) is not None,
                f"{field}.{name}")
        require(set(identifier.replace("-", "")) != {"0"}, f"{field}.{name}")
    require(len(value.values()) == len(set(value.values())), field)
    return value


def load_resources(root: Path) -> dict:
    value = fields(read_public(root / "config/resources.toml"),
                   {"version", "account_id", "zone_id", "access_audiences", "d1_databases", "durable_objects"}, "resources",
                   {"access_app_ids", "access_policy_ids", "standalone_access_app_ids", "flowday_app_ids", "referenced_policy_ids"})
    require(type(value["version"]) is int and value["version"] == 1, "resources.version")
    for key in ("account_id", "zone_id"):
        require(isinstance(value[key], str) and re.fullmatch(r"[0-9a-f]{32}", value[key]) is not None,
                "resources." + key)
        require(set(value[key]) != {"0"}, "resources." + key)
    identifiers(value["access_audiences"], "resources.access_audiences", r"[0-9a-f]{64}")
    identifiers(value["d1_databases"], "resources.d1_databases", r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
    identifiers(value["durable_objects"], "resources.durable_objects", r"[0-9a-f]{32}")
    for key in ("access_app_ids", "access_policy_ids", "standalone_access_app_ids", "flowday_app_ids", "referenced_policy_ids"):
        if key in value:
            identifiers(value[key], "resources." + key, r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
    return value
