"""httpx client for Newsletter's existing versioned, private durable drain contract."""

import httpx
from ziyixi_proto.http_routes import decode_json_body

ORIGIN = "http://newsletter:8080"


class AdmissionUnavailable(RuntimeError):
    """A dependency failure; never print its body or force a gate open."""


class AdmissionBusy(RuntimeError):
    """Tracked work is still running; keep admission closed."""


class AdmissionConflict(RuntimeError):
    """Another durable operation owns admission; never replace its identity."""


class Client:
    def __init__(self, token: str, *, client: httpx.Client | None = None):
        self.token = token
        self.http = client or httpx.Client(
            trust_env=False, follow_redirects=False, timeout=10
        )

    def close(self):
        self.http.close()

    def call(self, action: str, key: str, *, timeout: float = 10) -> dict:
        if action not in {"status", "begin", "freeze", "resume"} or not self.token:
            raise AdmissionUnavailable("UNAVAILABLE")
        path = "/internal/deployment/drain" + (
            "/" + action if action != "status" else ""
        )
        try:
            options = {"json": {"request_key": key}} if action != "status" else {}
            with self.http.stream(
                "POST" if options else "GET",
                ORIGIN + path,
                headers={
                    "Authorization": "Bearer " + self.token,
                    "Accept-Encoding": "identity",
                },
                timeout=timeout,
                **options,
            ) as response:
                raw = bytearray()
                for chunk in response.iter_raw(chunk_size=1024):
                    if len(raw) + len(chunk) > 65536:
                        raise ValueError()
                    raw.extend(chunk)
                if (
                    response.status_code == 409
                    and action == "freeze"
                    and decode_json_body(bytes(raw), max_bytes=1024)
                    == {"error": "deployment_busy"}
                ):
                    raise AdmissionBusy("RELEASE_HELD")
                if response.status_code == 409 and decode_json_body(
                    bytes(raw), max_bytes=1024
                ) == {"error": "deployment_conflict"}:
                    raise AdmissionConflict("RELEASE_HELD")
                if (
                    response.status_code != 200
                    or response.headers.get("content-type", "")
                    .split(";", 1)[0]
                    .strip()
                    .lower()
                    != "application/json"
                    or response.headers.get("content-encoding", "identity").lower()
                    != "identity"
                ):
                    raise ValueError()
                value = decode_json_body(bytes(raw), max_bytes=65536)
        except (httpx.HTTPError, OSError, ValueError):
            raise AdmissionUnavailable("UNAVAILABLE") from None
        return self.validate(value, action, key)

    @staticmethod
    def validate(value: object, action: str, key: str) -> dict:
        fields = {
            "version",
            "request_key",
            "state",
            "busy",
            "inflight",
            "unknown",
            "queued",
        }
        if (
            not isinstance(value, dict)
            or set(value) != fields
            or type(value["version"]) is not int
            or value["version"] != 1
        ):
            raise AdmissionUnavailable("UNAVAILABLE")
        if type(value["busy"]) is not bool:
            raise AdmissionUnavailable("UNAVAILABLE")
        for field in ("inflight", "unknown", "queued"):
            counts = value[field]
            names = {
                "inflight": {
                    "activities",
                    "editions",
                    "packets",
                    "workflow_attempts",
                    "notion_entities",
                    "notion_versions",
                    "delivery",
                },
                "unknown": {
                    "interrupted_activities",
                    "packets",
                    "workflow_attempts",
                    "notion_entities",
                    "notion_versions",
                    "delivery",
                },
                "queued": {"editions", "collection_runs"},
            }[field]
            if (
                not isinstance(counts, dict)
                or set(counts) != names
                or any(
                    type(number) is not int or number < 0 for number in counts.values()
                )
            ):
                raise AdmissionUnavailable("UNAVAILABLE")
        if value["busy"] != any(value["inflight"].values()):
            raise AdmissionUnavailable("UNAVAILABLE")
        state, identity = value["state"], value["request_key"]
        if state not in {"active", "draining", "frozen", "resumed"}:
            raise AdmissionUnavailable("UNAVAILABLE")
        if state == "active" and identity is not None:
            raise AdmissionUnavailable("UNAVAILABLE")
        if state != "active" and (
            not isinstance(identity, str) or not 1 <= len(identity) <= 128
        ):
            raise AdmissionUnavailable("UNAVAILABLE")
        if action == "status":
            if state == "resumed":
                raise AdmissionUnavailable("UNAVAILABLE")
        else:
            allowed = {
                "begin": {"draining", "frozen"},
                "freeze": {"frozen"},
                "resume": {"resumed"},
            }
            if identity != key or state not in allowed[action]:
                raise AdmissionUnavailable("UNAVAILABLE")
        if state == "frozen" and value["busy"]:
            raise AdmissionUnavailable("UNAVAILABLE")
        return value
