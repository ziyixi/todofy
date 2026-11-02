"""Synthetic Storage binary-batch wire contract and field bounds."""

import copy
import hashlib
import json
import unittest

from proto_test_support import REPO, compact
from ziyixi_proto.storage.objects.v1 import objects_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

FIXTURES = REPO / "contracts/storage-objects-v1/fixtures"


def content_hash(data):
    blocks = (
        hashlib.sha256(data[index : index + 4 * 1024 * 1024]).digest()
        for index in range(0, len(data), 4 * 1024 * 1024)
    )
    return hashlib.sha256(b"".join(blocks)).hexdigest()


class StorageObjectsWire(unittest.TestCase):
    def test_binary_batch_metadata_fixtures_round_trip_exactly(self):
        for name, message_type in (
            ("manifest.json", pb.BatchCreateManifest),
            ("response.json", pb.BatchCreateResponse),
        ):
            raw = (FIXTURES / name).read_text()
            message = from_wire(message_type, json.loads(raw), strict=True).message
            self.assertEqual(compact(to_wire(message)), raw)

    def test_manifest_matches_exact_binary_segments_and_aggregate_hash(self):
        manifest = json.loads((FIXTURES / "manifest.json").read_text())
        body = (FIXTURES / "body.bin").read_bytes()
        self.assertEqual(manifest["content_hash"], content_hash(body))
        offset = 0
        for item in manifest["objects"]:
            segment = body[offset : offset + item["size_bytes"]]
            self.assertEqual(len(segment), item["size_bytes"])
            self.assertEqual(content_hash(segment), item["content_hash"])
            offset += item["size_bytes"]
        self.assertEqual(offset, len(body))

    def test_strict_manifest_rejects_oversize_invalid_hash_and_namespace_fields(self):
        original = json.loads((FIXTURES / "manifest.json").read_text())
        mutations = (
            lambda value: value.update(objects=value["objects"] * 17),
            lambda value: value["objects"][0].update(size_bytes=0),
            lambda value: value["objects"][0].update(size_bytes=33554433),
            lambda value: value["objects"][0].update(content_hash="not-a-hash"),
            lambda value: value.update(content_hash="not-a-hash"),
            lambda value: value.update(namespace="another-application"),
            lambda value: value["objects"][0].update(secret="synthetic-private-token"),
        )
        for mutate in mutations:
            value = copy.deepcopy(original)
            mutate(value)
            with self.subTest(mutation=mutate), self.assertRaises(WireJsonError):
                from_wire(pb.BatchCreateManifest, value, strict=True)


if __name__ == "__main__":
    unittest.main()
