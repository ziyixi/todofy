"""The proto/ IDL of task-intent-v1 against Todofy's own rules (proto/README.md). Test only: nothing under
worker/ imports ``ziyixi_proto`` yet (it is a dev dependency, so pywrangler does not vendor it).

The generated enums must carry exactly the values ``core/intents.py`` uses, and the wire JSON profile must
write back the canonical bytes Todofy freezes and hashes for every intent it accepts and every result it
builds.
"""

import json
from pathlib import Path

import pytest
from ziyixi_proto.todofy.taskintent.v1 import task_intent_pb as pb
from ziyixi_proto.wire_json import from_wire, to_wire

from tests import mail_contract
from todofy.core import intents
from todofy.core.intents import IntentError, ResultState

ROOT = mail_contract.TODOFY.parent / "contracts" / "task-intent-v1"
NOW = 1_790_000_000


def _compact(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _wire_names(cls: type) -> list[str]:
    return [member.name.lower() for member in cls if member != 0]


def test_enums_equal_core_intents() -> None:
    assert _wire_names(pb.ErrorCode) == [code.value for code in IntentError]
    assert _wire_names(pb.State) == [state.value for state in ResultState]


@pytest.mark.parametrize("path", sorted((ROOT / "fixtures" / "TaskIntent").glob("*.json")), ids=lambda p: p.name)
def test_strict_read_writes_todofys_canonical_form(path: Path) -> None:
    value = json.loads(path.read_text())
    message = from_wire(pb.TaskIntent, value, strict=True).message
    assert _compact(to_wire(message)) == intents.intent(value).canonical


def test_results_todofy_builds_read_back() -> None:
    for value in (
        intents.not_found("lab", "deck-2026-09-30-g1", NOW),
        intents.rejected_new("lab", "deck-2026-09-30-g1", IntentError.DAILY_LIMIT, NOW, 3600),
    ):
        read = from_wire(pb.TaskIntentResult, value)
        assert read.unrecognized == []
        assert to_wire(read.message) == value
