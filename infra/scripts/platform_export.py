"""Encrypt the new platform credentials to an owner-held, one-time CMS recipient.

Only the encrypted artifact leaves the runner. This module never emits a secret or a raw
provider response, and does not need a GitHub token with permission to write secrets.
"""

import json
import os
from pathlib import Path
import re
import subprocess


class ExportFailed(RuntimeError):
    """The export failed without revealing credentials."""


def encrypted_export(session, env: dict[str, str], fetch, directory: Path) -> None:
    """Read only the managed bootstrap output and this tunnel's connector token."""
    certificate = env.get("VPS_BOOTSTRAP_CERT", "")
    if not certificate:
        return
    if (
        len(certificate) > 8192
        or not certificate.startswith("-----BEGIN CERTIFICATE-----\n")
        or not certificate.rstrip().endswith("-----END CERTIFICATE-----")
    ):
        raise ExportFailed("Invalid bootstrap recipient")
    result = subprocess.run(
        [session.tofu.binary, "output", "-json", "platform_bootstrap"],
        cwd=directory,
        env=session.tofu.env,
        capture_output=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0 or len(result.stdout) > 8192:
        raise ExportFailed("Bootstrap output unavailable")
    try:
        value = json.loads(result.stdout)
        if set(value) != {"client_id", "client_secret", "tunnel_id"}:
            raise ValueError
        if not re.fullmatch(r"[0-9a-f-]{36}", value["tunnel_id"]):
            raise ValueError
        for name in ("client_id", "client_secret"):
            if not isinstance(value[name], str) or not re.fullmatch(r"[\x21-\x7e]{24,512}", value[name]):
                raise ValueError
    except (TypeError, ValueError, KeyError):
        raise ExportFailed("Invalid bootstrap output") from None
    account = session.values["account_id"]
    connector = fetch(f"/accounts/{account}/cfd_tunnel/{value['tunnel_id']}/token")
    if not isinstance(connector, str) or not re.fullmatch(r"[A-Za-z0-9+/=_-]{32,2048}", connector):
        raise ExportFailed("Tunnel connector credential unavailable")
    value["connector_token"] = connector
    value["version"] = 1
    cert_path = session.work / "bootstrap-recipient.pem"
    cert_path.write_text(certificate)
    cert_path.chmod(0o600)
    target = Path(env["RUNNER_TEMP"]) / "platform-bootstrap.cms"
    encrypted = subprocess.run(
        ["openssl", "cms", "-encrypt", "-aes-256-gcm", "-binary", "-outform", "DER",
         "-recip", str(cert_path), "-keyopt", "rsa_padding_mode:oaep", "-keyopt", "rsa_oaep_md:sha256"],
        input=json.dumps(value).encode(),
        capture_output=True,
        timeout=60,
        check=False,
    )
    if encrypted.returncode != 0 or not encrypted.stdout:
        raise ExportFailed("Credential encryption failed")
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(encrypted.stdout)
