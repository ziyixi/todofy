"""Machine CLI for the live service, without a second SQLite writer."""

import argparse
import json
import os
import re
import sys
import time
import urllib.error as errors
import urllib.parse as parse
import urllib.request as request


def configure(parser: argparse.ArgumentParser) -> None:
    """Register explicit drain controls with bounded optional waiting."""
    parser.add_argument(
        "action", choices=("status", "begin", "freeze", "resume")
    )
    parser.add_argument("--request-key")
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--timeout", type=float, default=600)


def call(action: str, key: str | None) -> dict[str, object]:
    """Use the existing machine token over an exact private service origin."""
    origin = os.getenv("NEWSLETTER_SERVICE_URL", "http://127.0.0.1:8080")
    parsed = parse.urlsplit(origin)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or (
            parsed.scheme == "http"
            and parsed.hostname not in {"127.0.0.1", "localhost", "newsletter"}
        )
    ):
        raise ValueError("Invalid private service origin")
    token = os.getenv("NEWSLETTER_SEND_TOKEN", "")
    if not token:
        raise ValueError("Missing machine identity")
    path = "/internal/deployment/drain"
    body = None
    if action != "status":
        if key is None:
            raise ValueError("An operation key is required")
        path += "/" + action
        body = json.dumps({"request_key": key}).encode()
    operation = request.Request(
        origin.rstrip("/") + path,
        data=body,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
        method="GET" if body is None else "POST",
    )
    # Do not follow redirects carrying deployment credentials to another host.
    opener = request.build_opener(request.ProxyHandler({}), _NoRedirect())
    with opener.open(operation, timeout=10) as response:
        body = response.read(65537)
        if len(body) > 65536:
            raise ValueError("Deployment response too large")
        value = json.loads(body)
    return validate_response(value, action, key)


def validate_response(
    value: object, action: str, key: str | None
) -> dict[str, object]:
    """Fail closed on incomplete, stale or misleading successful responses."""
    fields = {
        "version",
        "request_key",
        "state",
        "busy",
        "inflight",
        "unknown",
        "queued",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("Invalid deployment response")
    if type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("Invalid deployment response version")
    if type(value["busy"]) is not bool:
        raise ValueError("Invalid deployment activity flag")
    _counts(
        value["inflight"],
        {
            "activities",
            "editions",
            "packets",
            "workflow_attempts",
            "notion_entities",
            "notion_versions",
            "delivery",
        },
    )
    _counts(
        value["unknown"],
        {
            "interrupted_activities",
            "packets",
            "workflow_attempts",
            "notion_entities",
            "notion_versions",
            "delivery",
        },
    )
    _counts(value["queued"], {"editions", "collection_runs"})
    if value["busy"] is not any(value["inflight"].values()):
        raise ValueError("Inconsistent deployment activity counts")
    state, identity = value["state"], value["request_key"]
    if not isinstance(state, str) or state not in {
        "active",
        "draining",
        "frozen",
        "resumed",
    }:
        raise ValueError("Invalid deployment state")
    if state == "active":
        if identity is not None:
            raise ValueError("Invalid active operation identity")
    elif not isinstance(identity, str) or not re.fullmatch(
        r"[\x21-\x7e]{1,128}", identity
    ):
        raise ValueError("Invalid deployment operation identity")
    if state == "frozen" and value["busy"]:
        raise ValueError("Frozen operation still has local work")
    if action == "status":
        if state == "resumed":
            raise ValueError("Resumed operations cannot hold the gate")
    else:
        expected = {
            "begin": {"draining", "frozen"},
            "freeze": {"frozen"},
            "resume": {"resumed"},
        }
        if identity != key or state not in expected.get(action, set()):
            raise ValueError("Deployment acknowledgement does not match")
    return value


def _counts(value: object, names: set[str]) -> None:
    if (
        not isinstance(value, dict)
        or set(value) != names
        or any(type(count) is not int or count < 0 for count in value.values())
    ):
        raise ValueError("Invalid deployment counts")


class _NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> None:
        return None


def execute(args: argparse.Namespace) -> dict[str, object]:
    """Wait for an explicit freeze; a timeout leaves admission closed."""
    if not 0 < args.timeout <= 86400 or (args.wait and args.action != "freeze"):
        raise ValueError("Invalid deployment wait")
    deadline = time.monotonic() + args.timeout
    while True:
        try:
            return call(args.action, args.request_key)
        except errors.HTTPError as error:
            if not args.wait or error.code != 409:
                raise
            value = json.loads(error.read(1025))
            if value != {"error": "deployment_busy"}:
                raise
        if time.monotonic() >= deadline:
            raise TimeoutError("Deployment drain remains held")
        time.sleep(min(2, max(0, deadline - time.monotonic())))


def main(args: argparse.Namespace) -> int:
    """Print content-free JSON or one safe error; never echo credentials."""
    try:
        print(json.dumps(execute(args), sort_keys=True))
    except (OSError, ValueError, RuntimeError):
        print("NEWSLETTER_DEPLOYMENT_CONTROL_FAILED", file=sys.stderr)
        return 1
    return 0
