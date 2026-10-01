"""Synthetic mail.received.v1 documents for the differential tests of the move onto the IDL
(proto/mailhero/webhook/v1/mail_received.proto): every fixture of contracts/mail-received-v1 (current and legacy),
and mutations of each that touch one field, list or relation at a time. No real mail: every value is made up.

tests/unit/test_mail_received_schema_legacy.py gives each document the generated and the frozen hand-written
schema's verdicts; tests/unit/test_mail_received_parser_legacy.py gives each one the parser's and the frozen
parser's. ``documents()`` is deterministic (no randomness), so a failure names the same document every run.
"""

import copy
import json
from collections.abc import Iterator
from typing import Any

from tests import mail_contract

# Subjects and texts: blank and not blank by Python's whitespace (str.strip()), and characters ECMAScript reads
# differently (U+FEFF is whitespace there, U+001C and U+0085 are not).
TEXTS = ["", " ", "\u3000\n", "\x1c", "\x85", "\ufeff", "a", " a ", "\u200b", "\x00", "\ud800", "x" * 70, "长"]
UUIDS = [
    "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e7100ff",
    "F8C1E9A0-1A98-4FB8-8CA1-4C0A3E7100FF",
    "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e7100f",
    "f8c1e9a01a984fb88ca14c0a3e7100ff",
    "{f8c1e9a0-1a98-4fb8-8ca1-4c0a3e7100ff}",
    "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e7100ff\n",
    "g8c1e9a0-1a98-4fb8-8ca1-4c0a3e7100ff",
    "",
]
TIMES = [
    "2026-09-28T08:00:00.000Z",
    "2026-09-28T08:00:00Z",
    "2026-09-28t08:00:00Z",
    "2026-09-28T08:00:00z",
    "2026-09-28T08:00:00.123456789Z",
    "2026-09-28T08:00:00.1234567891Z",
    "2026-09-28T08:00:00+00:00",
    "2026-09-28T08:00:00.5-07:00",
    "2026-09-28 08:00:00Z",
    "2026-02-30T08:00:00Z",
    "2026-09-28T24:00:00Z",
    "2026-13-01T08:00:00Z",
    "0001-01-01T00:00:00Z",
    "0000-01-01T00:00:00.000Z",
    "+010000-01-01T00:00:00.000Z",
    "-000001-12-31T23:59:59.999Z",
    "+10000-01-01T00:00:00Z",
    "+010000-01-01T00:00:00.000+01:00",
    "２０２６-09-28T08:00:00Z",
    "2026-09-28T08:00:00Z\n",
    "yesterday",
]
RUN_IDS = ["canary-2026-09-28", "c", "canary.1_x-y", "x" * 64, "x" * 65, "", "-canary", "canary 1", "canary-1\n"]
NUMBERS: list[Any] = [0, 1, 37, -1, 1.0, 19.5, True, "3", None, 2**31 - 1, 2**31, 1e300]
SCALARS: list[Any] = [None, True, 0, "", "x", [], {}]


def fixtures() -> dict[str, dict[str, Any]]:
    """Every fixture (current and legacy) as a parsed document, by name."""
    return {name: json.loads(path.read_bytes()) for name, path in mail_contract.fixtures().items()}


def _set(document: dict[str, Any], path: tuple[Any, ...], value: Any) -> dict[str, Any]:
    changed = copy.deepcopy(document)
    target = changed
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return changed


def _drop(document: dict[str, Any], path: tuple[Any, ...]) -> dict[str, Any]:
    changed = copy.deepcopy(document)
    target = changed
    for key in path[:-1]:
        target = target[key]
    del target[path[-1]]
    return changed


def _fields(document: dict[str, Any]) -> Iterator[tuple[Any, ...]]:
    """Every field path of a document: the event's, the canary's, the message's, the first address's and
    attachment's."""
    for key in document:
        yield (key,)
    for key in document.get("canary", {}):
        yield ("canary", key)
    message = document["message"]
    for key in message:
        yield ("message", key)
    for name in ("from", "to", "attachments"):
        if message[name]:
            for key in message[name][0]:
                yield ("message", name, 0, key)


def mutations(document: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """One change at a time: each field dropped and set to values of the wrong kind, then values of the right kind
    near each rule's edge."""
    for path in _fields(document):
        yield _drop(document, path)
        for value in SCALARS:
            yield _set(document, path, value)
    yield _set(document, ("newer_field",), {"anything": [1, 2]})
    yield _set(document, ("message", "newer_field"), 1)
    for value in UUIDS:
        yield _set(document, ("event_id",), value)
        yield _set(document, ("message", "id"), value)
    for value in TIMES:
        yield _set(document, ("received_at",), value)
        yield _set(document, ("message", "sent_at"), value)
    yield _set(document, ("type",), "mail.received.v2")
    for run_id in RUN_IDS:
        yield _set(document, ("canary",), {"run_id": run_id})
    yield _set(document, ("canary",), {"run_id": "canary-1", "attempt": 2})
    yield _set(document, ("canary",), "canary-1")
    message = document["message"]
    for subject in TEXTS:
        for text in TEXTS:
            yield _set(_set(document, ("message", "subject"), subject), ("message", "text"), text)
    yield _set(document, ("message", "subject"), "字" * 1366)
    yield _set(document, ("message", "text"), "a" * (256 << 10) + "é")
    for name in ("original_text_bytes", "attachments_omitted_count"):
        for value in NUMBERS:
            yield _set(document, ("message", name), value)
    size = len(message["text"].encode(errors="surrogatepass"))
    for truncated in (True, False, None, "absent"):
        for original in (size - 1, size, size + 1, None, "absent"):
            changed = copy.deepcopy(document)
            for name, value in (("text_truncated", truncated), ("original_text_bytes", original)):
                if value == "absent":
                    changed["message"].pop(name, None)
                else:
                    changed["message"][name] = value
            yield changed
    for name in ("text_truncated", "html_omitted", "needs_review"):
        for value in (True, False, "true", 1):
            yield _set(document, ("message", name), value)
    for value in ([], ["text_truncated"], ["ok", 1], [None], "x"):
        yield _set(document, ("message", "warnings"), value)
    address = {"address": "a@example.org", "name": ""}
    for count in (0, 1, 50, 51):
        yield _set(document, ("message", "from"), [address] * count)
        yield _set(document, ("message", "to"), [address] * count)
    for changed_address in ({"address": "a@example.org"}, {"address": 1, "name": ""}, {**address, "extra": 1}):
        yield _set(document, ("message", "from"), [changed_address])
    attachment = {"filename": "a.txt", "content_type": "text/plain", "size": 1}
    for count in (100, 101):
        yield _set(document, ("message", "attachments"), [attachment] * count)
    for status in ("stored", "omitted", "deleted", "", None, ["stored"]):
        yield _set(document, ("message", "attachments"), [{**attachment, "storage_status": status}])
    for reason in ("size_limit", "message_size_limit", "inline_image", "capacity", "virus", "", None):
        yield _set(document, ("message", "attachments"), [{**attachment, "omitted_reason": reason}])
    for value in NUMBERS:
        yield _set(document, ("message", "attachments"), [{**attachment, "size": value}])
    yield _set(document, ("message", "attachments"), [{**attachment, "extra": {"x": 1}}])


def documents() -> list[tuple[str, Any]]:
    """(label, document) for every fixture, every mutation of each and a few documents that are not events. A label
    is the fixture's name and the mutation's number, so a failure points at one document."""
    out: list[tuple[str, Any]] = []
    for name, document in fixtures().items():
        out.append((name, document))
        out += [(f"{name}#{i}", changed) for i, changed in enumerate(mutations(document))]
    out += [("not an object", value) for value in (None, [], "x", 1)]
    out += [
        ("no message", {"type": "mail.received.v1"}),
        ("message is null", {**fixtures()["plain_text"], "message": None}),
    ]
    return out
