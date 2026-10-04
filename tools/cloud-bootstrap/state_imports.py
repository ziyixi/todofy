"""Standard OpenTofu imports populate state before comparing dependent resources."""

from __future__ import annotations

import subprocess

import infra_state
from private_input import BootstrapError


def addresses(session) -> set[str]:
    try:
        result = subprocess.run([session.tofu.binary, "state", "list"], cwd=session.tofu.directory,
                                env=session.tofu.env, capture_output=True, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise BootstrapError("BOOTSTRAP_STATE_LIST_FAILED") from None
    if result.returncode or len(result.stdout) > 1048576:
        raise BootstrapError("BOOTSTRAP_STATE_LIST_FAILED")
    return set(result.stdout.decode().splitlines())


def adopt(session, imports: dict[str, str], existed: bool, env: dict[str, str]) -> list[str]:
    existing = addresses(session) if existed else set()
    missing = {address: identifier for address, identifier in imports.items() if address not in existing}
    # The count index is a reviewed state-address move, not another live application to import.
    if "cloudflare_zero_trust_access_application.mail_hero_backup" in existing:
        missing.pop("cloudflare_zero_trust_access_application.mail_hero_backup[0]", None)
    if missing and existed:
        infra_state.backup_state(session, "production", env)
    imported = []
    for address, identifier in sorted(missing.items()):
        code = session.tofu.run("import", "-input=false", "-no-color", f"-var-file={session.values_file}", address, identifier)
        if code:
            raise BootstrapError("BOOTSTRAP_IMPORT_FAILED", {"address": address, "headlines": session.tofu.headlines()})
        imported.append(address)
    return imported
