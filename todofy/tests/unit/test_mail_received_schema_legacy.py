"""The generated mail.received.v1 schema (contracts/mail-received-v1/mail-received-v1.schema.json, from
proto/mailhero/webhook/v1/mail_received.proto) against the hand-written one it replaced
(contracts/mail-received-v1/legacy/, frozen), read with Python's re: the same verdict on every document of
tests/unit/mail_cases.py (every fixture and about 9,000 mutations of them).

The hand-written schema states UUIDs and times as JSON Schema formats (`uuid`, `date-time`); the generated one keeps
both formats and adds the patterns the wire codec checks. So the verdicts are compared with format assertion on, as
the schema means them: a validator that ignores formats now also refuses, through the patterns, an ID that is not a
UUID and a time that is not RFC 3339, which Todofy always refused; it accepts nothing the hand-written schema
refused (test_without_format_assertion_the_generated_schema_only_adds_the_formats_patterns).

"Not blank" (a subject or a text) is compared character by character over all of Unicode: the hand-written \\S, read
by Python's re as Todofy's str.strip() reads it, against the generated Visible, Python's whitespace written out. In
ECMAScript's dialect the two differ on U+001C-U+001F, U+0085 and U+FEFF on purpose (mail_received.proto's header);
mail-hero/cloudflare/test/contract-schema-dialect.test.mjs holds that comparison.
"""

import datetime
import json
import re
from pathlib import Path
from typing import Any

import pytest

from tests import mail_contract
from tests.unit import mail_cases

jsonschema = pytest.importorskip("jsonschema", reason="dev dependency jsonschema is not installed")

LEGACY = mail_contract.CONTRACT / "legacy" / "mail-received-v1.schema.json"
DOCUMENTS = mail_cases.documents()

# A format checker that asserts `date-time` and `uuid`. jsonschema's own checks date-time only with the optional
# rfc3339-validator package, and reads a UUID through Python's uuid.UUID, which also takes braces and "urn:uuid:".
FORMATS = jsonschema.FormatChecker(formats=())
RFC3339 = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})"
)
UUID = re.compile(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")


@FORMATS.checks("date-time")
def rfc3339(value: object) -> bool:
    """RFC 3339's date-time: its shape, then a real date and time of day (leap seconds aside)."""
    if not isinstance(value, str):
        return True
    match = RFC3339.fullmatch(value)
    if match is None:
        return False
    try:
        datetime.datetime(*(int(part) for part in match.groups()[:6]))
    except ValueError:
        return False
    return True


@FORMATS.checks("uuid")
def uuid(value: object) -> bool:
    """RFC 9562's text form, any case."""
    return not isinstance(value, str) or UUID.fullmatch(value) is not None


def validator(path: Path, formats: bool = True) -> Any:
    schema = json.loads(path.read_text())
    return jsonschema.Draft202012Validator(schema, format_checker=FORMATS if formats else None)


GENERATED = validator(mail_contract.SCHEMA)
HAND_WRITTEN = validator(LEGACY)


def test_the_corpus_covers_both_verdicts():
    verdicts = [GENERATED.is_valid(document) for _, document in DOCUMENTS]
    assert len(DOCUMENTS) > 3000
    assert verdicts.count(True) > 500 and verdicts.count(False) > 1000


def test_the_generated_schema_gives_the_hand_written_verdict():
    differ = [
        (label, GENERATED.is_valid(document))
        for label, document in DOCUMENTS
        if GENERATED.is_valid(document) != HAND_WRITTEN.is_valid(document)
    ]
    assert differ == []


def test_without_format_assertion_the_generated_schema_only_adds_the_formats_patterns():
    generated, hand_written = validator(mail_contract.SCHEMA, formats=False), validator(LEGACY, formats=False)
    for label, document in DOCUMENTS:
        if generated.is_valid(document) == hand_written.is_valid(document):
            continue
        # Only the patterns of the formats tighten it, and only on what an asserting validator refused anyway.
        assert hand_written.is_valid(document) and not HAND_WRITTEN.is_valid(document), label


@pytest.mark.parametrize("name", list(mail_cases.fixtures()))
def test_every_fixture_validates_against_both(name):
    document = mail_cases.fixtures()[name]
    # sent_at_extended_year's year 10000 is not RFC 3339 (JavaScript's toISOString() of such a Date header): a
    # validator that asserts formats refuses it in both schemas; Todofy reads it as an unknown send time.
    asserted = name != "sent_at_extended_year"
    assert GENERATED.is_valid(document) == HAND_WRITTEN.is_valid(document) == asserted
    assert validator(mail_contract.SCHEMA, formats=False).is_valid(document)
    assert validator(LEGACY, formats=False).is_valid(document)


def test_not_blank_agrees_on_every_character():
    """A subject or a text alone, inside text and around text, over all of Unicode (lone surrogates included)."""
    legacy = json.loads(LEGACY.read_text())["properties"]["message"]["anyOf"][0]["properties"]["subject"]["pattern"]
    generated = json.loads(mail_contract.SCHEMA.read_text())["properties"]["message"]["anyOf"][0]
    pattern = re.compile(generated["properties"]["subject"]["pattern"])
    assert legacy == "\\S"
    disagree = []
    for code in range(0x110000):
        char = chr(code)
        for text in (char, f"a{char}b", f"{char}{char}a", f"a{char}", f"{char}\n"):
            if bool(pattern.search(text)) != bool(re.search(legacy, text)):
                disagree.append(hex(code))
    assert disagree == []
