"""Dependency-free scheduler client, also runnable as a standalone Python file.

By default only enqueue a run. --wait observes it; --send authorizes its frozen
ready edition. Never retry a POST within one invocation. After uncertainty,
resume with the same issue date/request key: the server's durable records and
one-delivery-attempt-per-date guard are authoritative. No environment files or
provider credentials are loaded. Provider acceptance is not inbox delivery.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import hashlib
import json
import os
import re
import signal
import time
import types
from typing import cast
import urllib.error as error
import urllib.parse as parse
import urllib.request as urllib_request
import zoneinfo

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_RUN_STATES = {
    "queued",
    "collecting",
    "projecting",
    "editing",
    "ready",
    "blocked",
    "failed",
}
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_INTERNAL_ORIGIN = "http://newsletter:8080"


class TriggerError(Exception):
    """Only credential-free messages may cross the CLI boundary."""


class NoRedirect(urllib_request.HTTPRedirectHandler):
    """Refuse redirects so bearer credentials stay on the configured origin."""

    def redirect_request(
        self,
        req: urllib_request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> None:
        """Never construct a follow-up request for a redirection response."""
        return


@dataclasses.dataclass(frozen=True)
class Config:
    """Validated scheduler options with credential fields excluded from repr."""

    origin: str
    editor_token: str = dataclasses.field(repr=False)
    send_token: str = dataclasses.field(repr=False)
    issue_date: str
    request_key: str
    wait: bool
    send: bool
    timeout: int
    poll_interval: int

    @classmethod
    def from_args(cls, args: argparse.Namespace) -> Config:
        """Read explicit process settings without loading environment files."""
        origin = os.environ.get("NEWSLETTER_SERVICE_URL", "").rstrip("/")
        allow_internal = os.environ.get("NEWSLETTER_ALLOW_INTERNAL_HTTP", "0")
        try:
            parsed = parse.urlsplit(origin)
            valid = (
                bool(parsed.hostname)
                and parsed.port != 0
                and parsed.username is None
                and parsed.password is None
                and not (parsed.query or parsed.fragment or parsed.path)
                and not any(c.isspace() or ord(c) < 32 for c in origin)
                and not any(c in origin for c in "\\%?#")
                and allow_internal in {"0", "1"}
                and (
                    parsed.scheme == "https"
                    or (allow_internal == "1" and origin == _INTERNAL_ORIGIN)
                )
            )
        except ValueError:
            valid = False
        if not valid:
            raise TriggerError(
                "NEWSLETTER_SERVICE_URL must be a fixed HTTPS origin; only "
                "exact "
                "http://newsletter:8080 is allowed with "
                "NEWSLETTER_ALLOW_INTERNAL_HTTP=1"
            )

        def token(name: str) -> str:
            value = os.environ.get(name, "")
            if not 24 <= len(value) <= 512 or any(
                not 33 <= ord(c) <= 126 for c in value
            ):
                raise TriggerError(
                    f"Set a valid {name} in the process environment"
                )
            return value

        editor_token = token("NEWSLETTER_EDITOR_TOKEN")
        send_token = token("NEWSLETTER_SEND_TOKEN") if args.send else ""
        if args.send and send_token == editor_token:
            raise TriggerError("Editor and send tokens must be distinct")
        try:
            zone = zoneinfo.ZoneInfo(
                os.environ.get("NEWSLETTER_TIME_ZONE", "America/Los_Angeles")
            )
            issue_date = (
                os.environ.get("NEWSLETTER_ISSUE_DATE")
                or datetime.datetime.now(zone).date().isoformat()
            )
            if (
                datetime.date.fromisoformat(issue_date).isoformat()
                != issue_date
            ):
                raise ValueError
        except (ValueError, zoneinfo.ZoneInfoNotFoundError):
            raise TriggerError(
                "Configure a valid issue date and IANA time zone"
            ) from None
        key = os.environ.get("NEWSLETTER_REQUEST_KEY") or "daily-" + issue_date
        if (
            not 1 <= len(key) <= 128
            or key != key.strip()
            or any(ord(c) < 32 or ord(c) == 127 for c in key)
        ):
            raise TriggerError(
                "NEWSLETTER_REQUEST_KEY must be 1..128 characters on one line"
            )
        if not 1 <= args.timeout <= 86400 or not 1 <= args.poll_interval <= 300:
            raise TriggerError(
                "Timeout must be 1..86400 seconds; poll interval must be 1..300"
            )
        return cls(
            origin,
            editor_token,
            send_token,
            issue_date,
            key,
            args.wait or args.send,
            args.send,
            args.timeout,
            args.poll_interval,
        )


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or any(
        not isinstance(key, str) for key in value
    ):
        raise ValueError("Invalid object")
    return cast(dict[str, object], value)


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate field")
        value[key] = item
    return value


def _string(value: object, pattern: re.Pattern[str]) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError("Invalid field")
    return value


def _run(value: dict[str, object], config: Config) -> dict[str, str]:
    state = value.get("state")
    if not isinstance(state, str) or state not in _RUN_STATES:
        raise ValueError("Invalid run state")
    if value.get("issue_date") != config.issue_date:
        raise ValueError("Different issue date")
    return {
        "id": _string(value.get("id"), _ID),
        "state": state,
        "issue_date": config.issue_date,
        "instructions_hash": _string(value.get("instructions_hash"), _HASH),
    }


def _edition(
    value: dict[str, object], edition_id: str, config: Config
) -> tuple[str, str]:
    if (
        value.get("id") != edition_id
        or value.get("issue_date") != config.issue_date
    ):
        raise TriggerError(
            "Edition identity does not match the completed run; not sending"
        )
    if value.get("is_fixture") is not False or value.get("state") != "ready":
        raise TriggerError(
            "Only a non-fixture ready edition may proceed; not sending"
        )
    try:
        if _object(value.get("review")).get("passed") is not True:
            raise ValueError("Review did not pass")
        render_hash = _string(
            _object(value.get("rendered")).get("render_hash"), _HASH
        )
        delivery = value.get("delivery_state")
        if not isinstance(delivery, str) or delivery not in {
            "not_requested",
            "submitting",
            "simulated",
            "provider_accepted",
            "rejected",
            "unknown",
        }:
            raise ValueError("Invalid delivery state")
    except ValueError:
        raise TriggerError(
            "Edition is missing a valid review, frozen hash or delivery state"
        ) from None
    return render_hash, delivery


class _Transport:
    """Keep one deadline and one non-proxy, non-redirecting HTTP client."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.deadline = time.monotonic() + config.timeout
        self.client = urllib_request.build_opener(
            NoRedirect(), urllib_request.ProxyHandler({})
        )

    def remaining(self) -> float:
        """Return the shared time budget without resetting between requests."""
        value = self.deadline - time.monotonic()
        if value <= 0:
            raise TriggerError(
                "Trigger deadline exceeded; resume only with the same "
                "date/request key"
            )
        return value

    def request(
        self,
        path: str,
        *,
        payload: dict[str, str] | None = None,
        sending: bool = False,
    ) -> dict[str, object]:
        """Perform one request; transport ambiguity never causes a retry."""
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib_request.Request(
            self.config.origin + path,
            data=data,
            method="POST" if data is not None else "GET",
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer "
                + (
                    self.config.send_token
                    if sending
                    else self.config.editor_token
                ),
            },
        )
        if sending:
            phase = "Send"
        elif data is not None:
            phase = "Trigger"
        else:
            phase = "Read"
        timeout = min(45 if sending else 30, self.remaining())
        try:
            with self.client.open(req, timeout=timeout) as response:
                raw = response.read(_MAX_RESPONSE_BYTES + 1)
            if len(raw) > _MAX_RESPONSE_BYTES:
                raise ValueError("Response too large")
            return _object(json.loads(raw, object_pairs_hook=_unique_object))
        except TriggerError:
            raise
        except error.HTTPError as exc:
            outcome = "not confirmed" if sending else "rejected"
            raise TriggerError(
                f"{phase} {outcome} (HTTP {exc.code}); no automatic retry"
            ) from None
        # This standalone CLI is the final transport boundary. Its only safe
        # outcome for an unexpected read failure is an explicit unknown result.
        except Exception:  # noqa: BLE001
            guidance = (
                "inspect the edition before resuming with the same "
                "date/request key; never change keys"
                if sending
                else "retry only with the same request key"
            )
            raise TriggerError(f"{phase} outcome unknown; {guidance}") from None


def execute(config: Config) -> dict[str, str]:
    """Enqueue once, optionally observe, and authorize at most one send."""
    transport = _Transport(config)

    raw_run = transport.request(
        "/v1/runs",
        payload={
            "request_key": config.request_key,
            "issue_date": config.issue_date,
        },
    )
    try:
        result = _run(raw_run, config)
    except ValueError:
        raise TriggerError(
            "Trigger outcome unknown; retry only with the same request key"
        ) from None
    if not config.wait:
        return result
    run_id, instructions_hash = result["id"], result["instructions_hash"]
    while True:
        if raw_run.get("is_fixture") is not False:
            raise TriggerError(
                "Only a non-fixture run may proceed; not sending"
            )
        if result["state"] in {"blocked", "failed"}:
            raise TriggerError(
                f"Run {result['state']}; "
                "not sending or creating a replacement run"
            )
        if result["state"] == "ready":
            break
        time.sleep(min(config.poll_interval, transport.remaining()))
        raw_run = transport.request("/v1/runs/" + run_id)
        try:
            result = _run(raw_run, config)
            if (
                result["id"] != run_id
                or result["instructions_hash"] != instructions_hash
            ):
                raise ValueError("Different run")
        except ValueError:
            raise TriggerError("Invalid run observation; not sending") from None

    try:
        edition_id = _string(raw_run.get("edition_id"), _ID)
    except ValueError:
        raise TriggerError(
            "Ready run has no valid edition ID; not sending"
        ) from None
    path = "/v1/editions/" + edition_id
    render_hash, delivery = _edition(
        transport.request(path), edition_id, config
    )
    result.update(
        edition_id=edition_id, render_hash=render_hash, delivery_state=delivery
    )
    if not config.send:
        return result
    if delivery == "not_requested":
        key = (
            "trigger-send-"
            + hashlib.sha256(
                json.dumps([config.issue_date, config.request_key]).encode()
            ).hexdigest()
        )
        sent = transport.request(
            path + "/send",
            sending=True,
            payload={
                "id": edition_id,
                "request_key": key,
                "expected_render_hash": render_hash,
            },
        )
        observed_hash, delivery = _edition(sent, edition_id, config)
        if observed_hash != render_hash:
            raise TriggerError(
                "Send response changed the frozen hash; inspect the edition"
            )
        result["delivery_state"] = delivery
    if delivery != "provider_accepted":
        raise TriggerError(
            f"Delivery state {delivery}; "
            "no further send attempted; inspect the existing edition"
        )
    return result


def main(argv: list[str] | None = None) -> None:
    """Run the scheduler with a process-wide deadline and safe diagnostics."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--wait",
        action="store_true",
        help="Wait for a non-fixture ready edition",
    )
    parser.add_argument(
        "--send",
        action="store_true",
        help="Wait and authorize the frozen edition",
    )
    parser.add_argument(
        "--timeout", type=int, default=3600, help="Total deadline in seconds"
    )
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=10,
        help="Polling interval in seconds",
    )
    parser.add_argument(
        "--check-config",
        action="store_true",
        help="Validate without making requests",
    )
    args = parser.parse_args(argv)

    def expired(signum: int, frame: types.FrameType | None) -> None:
        raise TriggerError(
            "Trigger deadline exceeded; resume only with the same "
            "date/request key"
        )

    try:
        config = Config.from_args(args)
        if args.check_config:
            print(
                json.dumps(
                    {"configuration": "valid", "send_enabled": config.send}
                )
            )
            return
        # POSIX timer also bounds DNS resolution and trickling reads,
        # unlike socket timeouts alone. No send retry occurs after interruption.
        previous = signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, config.timeout)
        try:
            result = execute(config)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
        print(json.dumps(result))
    except TriggerError as exc:
        raise SystemExit(str(exc)) from None


if __name__ == "__main__":
    main()
