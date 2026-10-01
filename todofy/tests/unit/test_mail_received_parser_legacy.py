"""todofy.core.contract.parse_mail_event, which reads every mail.received.v1 body with the generated codec of
proto/mailhero/webhook/v1/mail_received.proto, against the parser it replaced (tests/unit/legacy/contract_before_idl.py,
frozen): the same verdict, the same event and the same log reason on every document of tests/unit/mail_cases.py (the
fixtures, current and legacy, and about 9,000 mutations of them), but one.

The one difference: an integer of the event (an attachment's size, original_text_bytes, attachments_omitted_count)
above 2^31 - 1 was accepted and is refused now ("shape"): the wire profile's integers are int32 (proto/README.md), and
no message Mail Hero can receive (25 MiB) has a size that large.
"""

import importlib.util
import json
from pathlib import Path
from typing import Any

from tests.unit import mail_cases
from todofy.core import contract

_SPEC = importlib.util.spec_from_file_location(
    "contract_before_idl", Path(__file__).parent / "legacy" / "contract_before_idl.py"
)
assert _SPEC is not None and _SPEC.loader is not None
before = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(before)

INT32_MAX = 2**31 - 1


def verdict(module: Any, raw: bytes) -> tuple[str, Any]:
    try:
        return "event", repr(module.parse_mail_event(raw)).replace(module.__name__, "")
    except module.ContractError as error:
        return "refused", error.reason


def beyond_int32(document: Any) -> bool:
    """Whether one of the event's integers is an int above int32 (the one difference, module docstring)."""
    if not isinstance(document, dict) or not isinstance(document.get("message"), dict):
        return False
    message = document["message"]
    values = [message.get("original_text_bytes"), message.get("attachments_omitted_count")]
    if isinstance(message.get("attachments"), list):
        values += [item.get("size") for item in message["attachments"] if isinstance(item, dict)]
    return any(type(value) is int and value > INT32_MAX for value in values)


def test_the_parser_gives_every_document_the_verdict_it_had_before_the_idl():
    differ, beyond = [], 0
    for label, document in mail_cases.documents():
        raw = json.dumps(document).encode()
        old, new = verdict(before, raw), verdict(contract, raw)
        if beyond_int32(document):
            beyond += 1
            assert new[0] == "refused", label
            continue
        if old != new:
            differ.append(
                (label, old[0], new[0], old[1] if old[0] == "refused" else "", new[1] if new[0] == "refused" else "")
            )
    assert differ == []
    assert beyond > 30


def test_the_event_types_are_the_same():
    """The parsed event (todofy.core.contract.MailEvent) keeps its fields, so nothing downstream changes."""
    assert [f for f in contract.MailEvent.__slots__] == [f for f in before.MailEvent.__slots__]
    assert contract.MailEvent.__dataclass_fields__.keys() == before.MailEvent.__dataclass_fields__.keys()
