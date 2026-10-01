"""The generated report schemas (api/*-v1.schema.json, from proto/todofy/report/v1) against the hand-written ones
they replaced (tests/unit/legacy/, frozen): the same verdict on every document, except where the IDL states one
rule more strictly for `stale`, a status no production Todofy ever sent (report.proto's header):

- a stale summary is never blank (the hand-written schema allowed a blank one when task_count was 0);
- a stale recommendation saw at least one mail (the hand-written schema allowed task_count 0 without tasks).

The text rules are compared character by character over all of Unicode: "not blank" is Python's whitespace (the
hand-written \\S, read by Python's re as the newsletter's str.strip() reads it), written out as a class that
ECMAScript reads the same way.
"""

import itertools
import json
import re
from pathlib import Path
from typing import Any

import pytest

jsonschema = pytest.importorskip("jsonschema", reason="dev dependency jsonschema is not installed")

UNIT = Path(__file__).parent
API = UNIT.parents[1] / "api"
NAMES = ("summary-v1.schema.json", "recommendation-v1.schema.json")
STAMPS = {
    "computed_at": "2026-09-28T13:30:00Z",
    "window_start": "2026-09-27T13:30:00Z",
    "window_end": "2026-09-28T13:30:00Z",
}
EMPTY = (
    "As there is no new task in the last 24 hours, there will have no summary. "
    "Please check your service as it's highly not possible that there is no new task in the last 24 hours.\n"
)


def validator(path: Path) -> Any:
    return jsonschema.Draft202012Validator(json.loads(path.read_text()))


GENERATED = {name: validator(API / name) for name in NAMES}
LEGACY = {name: validator(UNIT / "legacy" / name) for name in NAMES}


def summaries() -> list[dict[str, Any]]:
    texts = ["Important\n- 报税截止", "  \n", "", "　 ", "a\x07b", EMPTY, "x" * 12_001, "　报告"]
    out = []
    for status, count, text in itertools.product(
        ["ok", "empty_window", "stale", "model_output_invalid", "other"], [0, 1, 63, -1, 1_000_001], texts
    ):
        report = {"summary": text, "task_count": count, "time_window_hours": 24, "status": status, "model": ""}
        out.append(report | STAMPS)
    base = out[0] | {"status": "ok", "task_count": 4}
    out += [
        base | {"time_window_hours": 23},
        base | {"task_count": True},
        base | {"computed_at": "2026-09-28T13:30:00+00:00"},
        base | {"computed_at": "2026-09-28T13:30:00.000Z"},
        base | {"extra": 1},
        {key: value for key, value in base.items() if key != "model"},
        base | {"model": None},
    ]
    return out


def recommendations() -> list[dict[str, Any]]:
    task = {"rank": 1, "title": "报税", "reason": "今天截止"}
    task_lists = [
        [],
        [task],
        [{"rank": n, "title": f"t{n}", "reason": "r"} for n in range(1, 11)],
        [{"rank": n, "title": f"t{n}", "reason": "r"} for n in range(1, 12)],
        [task | {"rank": 0}],
        [task | {"rank": 11}],
        [task | {"title": " \t"}],
        [task | {"reason": ""}],
        [task | {"title": "t" * 201}],
        [task | {"reason": "r" * 4001}],
        [task | {"score": 1}],
        [{"rank": 1, "title": "t"}],
    ]
    counts = [{}, {"new_count": 0, "carryover_count": 0}, {"new_count": 3, "carryover_count": 2}, {"new_count": -1}]
    out = []
    for status, count, tasks, extra in itertools.product(
        ["ok", "empty_window", "model_output_invalid", "stale", "other"], [0, 1, 5, 1_000_001], task_lists, counts
    ):
        out.append({"tasks": tasks, "model": "m", "task_count": count, "status": status, "top_n": 10} | STAMPS | extra)
    base = out[0] | {"tasks": [task], "task_count": 4, "status": "ok"}
    out += [
        base | {"top_n": 0},
        base | {"top_n": 11},
        base | {"new_count": "1"},
        base | {"window_end": "2026-09-28"},
        {key: value for key, value in base.items() if key != "tasks"},
    ]
    return out


def tightened(name: str, document: dict[str, Any]) -> bool:
    """The documents the generated schema refuses on purpose (the module docstring)."""
    if document.get("status") != "stale" or document.get("task_count") != 0:
        return False
    if name == "summary-v1.schema.json":
        return isinstance(document.get("summary"), str) and not document["summary"].strip()
    return True


@pytest.mark.parametrize(("name", "documents"), [(NAMES[0], summaries()), (NAMES[1], recommendations())])
def test_the_generated_schema_gives_the_hand_written_verdict(name, documents):
    differ = []
    for document in documents:
        new = GENERATED[name].is_valid(document)
        old = LEGACY[name].is_valid(document)
        if new != old and not (old and not new and tightened(name, document)):
            differ.append((new, old, document))
    assert differ == []
    # The tightening is real: the stale cases above are refused now and were accepted before.
    stale = [d for d in documents if tightened(name, d) and LEGACY[name].is_valid(d)]
    assert stale and not any(GENERATED[name].is_valid(d) for d in stale)


def test_every_golden_report_validates_against_both():
    for report_name, text in json.loads((UNIT / "golden" / "reports-v1.json").read_text()).items():
        name = NAMES[0] if report_name.startswith("summary_") else NAMES[1]
        document = json.loads(text)
        assert GENERATED[name].is_valid(document), report_name
        assert LEGACY[name].is_valid(document), report_name


def legacy_text_ok(rules: dict[str, Any], text: str) -> bool:
    return bool(re.search(rules["pattern"], text)) and all(re.search(r["pattern"], text) for r in rules["allOf"])


def test_the_text_rules_agree_on_every_character():
    """Title, reason and summary: one character alone, inside text and around text, over all of Unicode."""
    legacy = json.loads((UNIT / "legacy" / NAMES[1]).read_text())["properties"]["tasks"]["items"]["properties"]["title"]
    generated = json.loads((API / NAMES[1]).read_text())["oneOf"][0]["properties"]["tasks"]["items"]
    pattern = re.compile(generated["properties"]["title"]["pattern"])
    disagree = []
    for code in itertools.chain(range(0xD800), range(0xE000, 0x110000)):
        char = chr(code)
        for text in (char, f"a{char}b", f"{char}{char}a", f"a{char}"):
            if bool(pattern.search(text)) != legacy_text_ok(legacy, text):
                disagree.append(hex(code))
    assert disagree == []
