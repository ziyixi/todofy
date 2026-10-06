"""GitHub's existing authentication encrypts production secrets; values enter gh only through stdin."""

from __future__ import annotations

import json
import re
import subprocess

from private_input import BootstrapError


def worker_secret_values(private: dict, scalar: dict, specs: dict, *, complete: bool = True) -> tuple[dict[str, str], list[str]]:
    configured = private.get("worker_secrets", {})
    if not isinstance(configured, dict) or set(configured) - set(specs):
        raise BootstrapError("WORKER_SECRETS_INVALID")
    result, missing = {}, []
    for worker, spec in specs.items():
        if not complete and worker not in configured:
            continue
        if not isinstance(configured.get(worker, {}), dict):
            raise BootstrapError("WORKER_SECRETS_INVALID")
        bindings = dict(configured.get(worker, {}))
        prefix = spec["github_secret"].removesuffix("_WORKER_SECRETS")
        if worker in {"flowday", "links", "watch"}:
            identity_prefix = "DASHBOARD"
        else:
            identity_prefix = prefix
        for name in set(spec["required"]) | set(spec["optional"]):
            if worker == "todofy-core" and name.startswith("TODOIST_"):
                source = "TODOFY_" + name
            else:
                source = identity_prefix + "_" + name if name.startswith("ACCESS_OWNER") else prefix + "_" + name
            if source in scalar:
                if name in bindings and bindings[name] != scalar[source]:
                    raise BootstrapError("WORKER_SECRET_CONSUMER_MISMATCH")
                bindings[name] = scalar[source]
        if set(bindings) - set(spec["required"]) - set(spec["optional"]):
            raise BootstrapError("WORKER_SECRET_NAME_INVALID")
        if any(not isinstance(value, str) or not value or len(value) > 16384 or "\x00" in value
               for value in bindings.values()):
            raise BootstrapError("WORKER_SECRET_VALUE_INVALID")
        missing.extend(worker + "." + name for name in spec["required"] if not bindings.get(name))
        result[spec["github_secret"]] = json.dumps(bindings, sort_keys=True, separators=(",", ":"))
    return result, sorted(missing)


def set_production(repository: str, secrets: dict[str, str], run=subprocess.run) -> None:
    if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) is None:
        raise BootstrapError("GITHUB_REPOSITORY_INVALID")
    for name, value in sorted(secrets.items()):
        if re.fullmatch(r"[A-Z][A-Z0-9_]+", name) is None or not isinstance(value, str) or "\x00" in value:
            raise BootstrapError("GITHUB_SECRET_INVALID")
        try:
            result = run(["gh", "secret", "set", name, "--repo", repository, "--env", "production"],
                         input=value.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         timeout=60, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise BootstrapError("GITHUB_SECRET_WRITE_FAILED") from None
        if result.returncode:
            raise BootstrapError("GITHUB_SECRET_WRITE_FAILED")
