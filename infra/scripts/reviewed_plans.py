"""Store an OpenTofu-encrypted plan for one reviewed Actions continuation."""

from __future__ import annotations

import hashlib
import hmac
import json
import re

import infra_state

KEY = re.compile(r"plans/production/[0-9]+-[0-9]+-[0-9a-f]{40}\.tfplan")


def _signature(document: dict, phrase: str) -> str:
    encoded = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(phrase.encode(), encoded, hashlib.sha256).hexdigest()


def save(session, plan, expected: str, env: dict[str, str]) -> str:
    source, run, attempt = env.get("GITHUB_SHA", ""), env.get("GITHUB_RUN_ID", ""), env.get("GITHUB_RUN_ATTEMPT", "1")
    if not re.fullmatch(r"[0-9a-f]{40}", source) or not run.isdigit() or not attempt.isdigit():
        raise infra_state.Refused("REVIEWED_PLAN_CONTEXT_INVALID")
    key = f"plans/production/{run}-{attempt}-{source}.tfplan"
    body = plan.read_bytes()
    document = {"version": 1, "source_sha": source, "expect": expected, "plan_sha256": hashlib.sha256(body).hexdigest()}
    document["mac"] = _signature(document, session.passphrase)
    for object_key, data in ((key, body), (key + ".json", json.dumps(document, sort_keys=True).encode())):
        status, _ = session.s3("HEAD", object_key)
        if status != 404:
            raise infra_state.Refused("REVIEWED_PLAN_KEY_ALREADY_EXISTS")
        status, _ = session.s3("PUT", object_key, data)
        if status not in (200, 201):
            raise infra_state.Refused("REVIEWED_PLAN_SAVE_FAILED")
        status, readback = session.s3("GET", object_key)
        if status != 200 or readback != data:
            raise infra_state.Refused("REVIEWED_PLAN_SAVE_NOT_VERIFIED")
    return key


def read(session, key: str, expected: str, env: dict[str, str]):
    if KEY.fullmatch(key) is None:
        raise infra_state.Refused("REVIEWED_PLAN_KEY_INVALID")
    status, raw = session.s3("GET", key + ".json")
    if status != 200 or len(raw) > 2048:
        raise infra_state.Refused("REVIEWED_PLAN_METADATA_UNAVAILABLE")
    try:
        document = json.loads(raw)
        if not isinstance(document, dict) or set(document) != {"version", "source_sha", "expect", "plan_sha256", "mac"}:
            raise ValueError
        signature = document.pop("mac")
        valid = (type(document["version"]) is int and document["version"] == 1
                 and document["source_sha"] == env.get("GITHUB_SHA") and document["expect"] == expected
                 and isinstance(signature, str) and hmac.compare_digest(signature, _signature(document, session.passphrase)))
        if not valid:
            raise ValueError
    except (TypeError, ValueError, KeyError):
        raise infra_state.Refused("REVIEWED_PLAN_METADATA_INVALID") from None
    status, body = session.s3("GET", key)
    if status != 200 or not body or len(body) > 8 * 1024 * 1024 or hashlib.sha256(body).hexdigest() != document["plan_sha256"]:
        raise infra_state.Refused("REVIEWED_PLAN_CONTENT_INVALID")
    path = session.work / "approved.tfplan"
    infra_state.write_private(path, "")
    path.write_bytes(body)
    return path


def github_output(path, state: str, expected: str = "", key: str = "") -> None:
    if path is None:
        return
    with path.open("a", encoding="utf-8") as handle:
        handle.write(f"state={state}\nexpect={expected}\nplan_key={key}\n")
