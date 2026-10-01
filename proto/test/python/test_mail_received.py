"""mailhero/webhook/v1/mail_received.proto is the IDL of contracts/mail-received-v1, in Python (TypeScript twin:
test/mail-received.test.ts): every current fixture is the codec's own bytes after a lenient read, the frozen legacy
event reads (and is not the codec's own bytes: retries resend it as frozen), a consumer's lenient read skips a newer
field and checks every rule, and the generated module names `from` as the attribute `from_`.
"""

import copy
import json
import unittest

from proto_test_support import REPO, compact
from ziyixi_proto.mailhero.webhook.v1 import mail_received_pb as pb
from ziyixi_proto.wire_json import WireJsonError, field_rules, from_wire, to_wire

FIXTURES = REPO / "contracts" / "mail-received-v1" / "fixtures"
CURRENT = {path.name: path.read_text(encoding="utf-8") for path in sorted(FIXTURES.glob("*.json"))}
LEGACY = {path.name: path.read_text(encoding="utf-8") for path in sorted((FIXTURES / "legacy").glob("*.json"))}
PLAIN = json.loads(CURRENT["plain_text.json"])


def mutate(change: dict, message: dict | None = None, drop: tuple[str, ...] = ()) -> dict:
    document = copy.deepcopy(PLAIN) | change
    document["message"] = {**PLAIN["message"], **(message or {})}
    for name in drop:
        del document["message"][name]
    return document


class FixturesTest(unittest.TestCase):
    def test_every_current_fixture_is_the_codecs_own_bytes(self) -> None:
        self.assertEqual(len(CURRENT), 16)
        for name, text in CURRENT.items():
            with self.subTest(name):
                read = from_wire(pb.MailReceivedEvent, json.loads(text))
                self.assertEqual(read.unrecognized, [])
                self.assertEqual(compact(to_wire(read.message)), text)

    def test_a_frozen_legacy_event_reads_and_is_never_rewritten(self) -> None:
        (text,) = LEGACY.values()
        read = from_wire(pb.MailReceivedEvent, json.loads(text)).message
        self.assertEqual((read.message.warnings, read.message.text_truncated), ((), None))
        rewritten = compact(to_wire(read))
        self.assertEqual(rewritten, text.replace(',"attachments":[]', ',"warnings":[],"attachments":[]'))


class ConsumerTest(unittest.TestCase):
    def test_a_newer_field_is_skipped_at_any_depth(self) -> None:
        document = mutate({"newer": 1, "canary": {"run_id": "canary-1", "attempt": 2}}, {"newer_flag": True})
        read = from_wire(pb.MailReceivedEvent, document)
        self.assertEqual(read.unrecognized, ["message.newer_flag", "newer", "canary.attempt"])
        self.assertEqual(read.message.canary.run_id, "canary-1")

    def test_every_rule_is_checked_on_a_lenient_read(self) -> None:
        attachment = {"filename": "a", "content_type": "b", "size": 1}
        for document, error in [
            (mutate({"type": "mail.received.v2"}), "type: not an allowed value"),
            (mutate({"event_id": "nope"}), "event_id: does not match Uuid"),
            (mutate({"received_at": "2026-09-28T08:00:00+00:00"}), "received_at: does not match ReceivedAt"),
            (mutate({"canary": {"run_id": "canary 1"}}), "canary.run_id: does not match RunId"),
            (mutate({"canary": None}), "canary: wrong type"),
            (PLAIN | {"message": None}, "message: required"),
            (mutate({}, {"subject": " ", "text": "　\n"}), "message: no value of subject, text matches Visible"),
            (
                mutate({}, {"text_truncated": True}, drop=("original_text_bytes",)),
                "message.original_text_bytes: required when text_truncated is true",
            ),
            (mutate({}, {"attachments": [attachment | {"size": -1}]}), "message.attachments[0].size: below the minimum"),
            (
                mutate({}, {"attachments": [attachment | {"storage_status": "deleted"}]}),
                "message.attachments[0].storage_status: unknown enum value",
            ),
            (mutate({}, {"from": [{"address": "a@example.org", "name": ""}] * 51}), "message.from: more than 50 items"),
            (mutate({}, {"sent_at": "yesterday"}), "message.sent_at: does not match SentAt"),
        ]:
            with self.subTest(error), self.assertRaises(WireJsonError) as caught:
                from_wire(pb.MailReceivedEvent, document)
            self.assertEqual(str(caught.exception), error)

    def test_what_consumers_have_always_accepted_reads(self) -> None:
        for change, message in [
            ({"event_id": "F8C1E9A0-1A98-4FB8-8CA1-4C0A3E710001"}, {}),
            ({}, {"sent_at": "2026-09-23T16:00:00.123456789+05:30"}),
            ({}, {"sent_at": "+010000-01-01T00:00:00.000Z"}),
            ({}, {"sent_at": None, "rfc_message_id": None}),
            ({}, {"subject": "   "}),
            ({}, {"subject": "﻿", "text": ""}),
        ]:
            with self.subTest(change=change, message=message):
                from_wire(pb.MailReceivedEvent, mutate(change, message))


class GeneratedModuleTest(unittest.TestCase):
    def test_from_is_the_attribute_from_(self) -> None:
        read = from_wire(pb.MailReceivedEvent, PLAIN).message
        self.assertEqual(read.message.from_, (pb.Address(address="sender@example.org", name="Sender Example"),))

    def test_the_bounds_are_read_from_the_tables(self) -> None:
        self.assertEqual(field_rules(pb.Mail, "from").max_items, 50)
        self.assertEqual(field_rules(pb.Mail, "attachments").max_items, 100)
        self.assertTrue(field_rules(pb.Mail, "warnings").write_empty)
        self.assertEqual(field_rules(pb.Mail, "original_text_bytes").present_when, "text_truncated")


if __name__ == "__main__":
    unittest.main()
