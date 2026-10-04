"""Create missing GitHub setup; existing operation flags and environment protections stay intact."""

from __future__ import annotations

import json
import subprocess

from private_input import BootstrapError

DEFAULT_VARIABLES = {
    "DASHBOARD_CANARY_ENABLED": "false",
    "MAIL_HERO_FORCE_SEND_PAUSED": "true",
    "MAIL_HERO_MAINTENANCE_MODE": "false",
    "MAIL_HERO_NATIVE_BACKUP_ENABLED": "true",
    "TODOFY_FORCE_PAUSE_TODOIST": "true",
    "TODOFY_GTD_REVIEW_ENABLED": "false",
    "TODOFY_MAINTENANCE_MODE": "false",
    "TODOFY_PROCESSING_PAUSED": "true",
    "TODOFY_REMINDER_ENABLED": "false",
    "VPS_DEPLOY_ENABLED": "false",
    "PERSONAL_CLOUD_AUTO_REPAIR": "false",
    "WEBSITE_SCHEDULED_RECONCILE": "false",
}


def api(path: str, method: str = "GET", body: dict | None = None, *, missing: bool = False):
    arguments = ["gh", "api", path, "--method", method]
    if body is not None:
        arguments.extend(["--input", "-"])
    try:
        result = subprocess.run(arguments, input=json.dumps(body).encode() if body is not None else None,
                                capture_output=True, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise BootstrapError("GITHUB_CONFIGURATION_UNAVAILABLE") from None
    if result.returncode:
        if missing and b"HTTP 404" in result.stderr:
            return None
        raise BootstrapError("GITHUB_CONFIGURATION_FAILED")
    if not result.stdout.strip():
        return {}
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise BootstrapError("GITHUB_CONFIGURATION_INVALID") from None


def variable_names(path: str, call=api) -> set[str]:
    names = set()
    for page in range(1, 11):
        result = call(path + "?per_page=100&page=" + str(page))
        if not isinstance(result, dict) or not isinstance(result.get("variables"), list):
            raise BootstrapError("GITHUB_VARIABLES_INVALID")
        entries = result["variables"]
        if any(not isinstance(item, dict) or not isinstance(item.get("name"), str) for item in entries):
            raise BootstrapError("GITHUB_VARIABLES_INVALID")
        names.update(item["name"] for item in entries)
        if len(entries) < 100:
            return names
    raise BootstrapError("GITHUB_VARIABLES_LIMIT_EXCEEDED")


def initialize(repository: str, *, mode: str = "fresh", call=api) -> dict:
    repo = call("repos/" + repository)
    if not isinstance(repo, dict) or repo.get("default_branch") != "main":
        raise BootstrapError("GITHUB_MAIN_BRANCH_REQUIRED")
    owner = repo.get("owner", {})
    created = []
    for name in ("production", "infra-review"):
        path = "repos/" + repository + "/environments/" + name
        current = call(path, missing=True)
        if current is not None:
            continue
        if name == "infra-review" and (owner.get("type") != "User" or type(owner.get("id")) is not int):
            raise BootstrapError("INFRA_REVIEW_OWNER_SELECTION_REQUIRED")
        body = {"deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True}}
        if name == "infra-review":
            body["reviewers"] = [{"type": "User", "id": owner["id"]}]
            body["prevent_self_review"] = False  # A personal cloud has one owner; review remains explicit.
        call(path, "PUT", body)
        call(path + "/deployment-branch-policies", "POST", {"name": "main", "type": "branch"})
        created.append(name)
    root = "repos/" + repository
    existing = variable_names(root + "/actions/variables", call)
    existing |= variable_names(root + "/environments/production/variables", call)
    variables = []
    for name, value in DEFAULT_VARIABLES.items():
        if mode == "adopt" and name == "WEBSITE_SCHEDULED_RECONCILE":
            continue  # Existing website schedules interpret an absent variable as enabled.
        if name not in existing:
            call(root + "/actions/variables", "POST", {"name": name, "value": value})
            variables.append(name)
    return {"environments_created": created, "variables_created": variables}
