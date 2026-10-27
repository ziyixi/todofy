"""tools/retired.py's `files` and `fields` kinds on synthetic buf images (JSON form), next to the module's own self-test
(scripts/rules-selftest.sh, which edits real .proto files): a retired file stays out of the head, leaves the base
with everything it defines, and may not be imported by a file the base keeps; a retired field stays out of the head
with its number and name reserved, and leaves the base.
"""

import sys
import unittest
from typing import Any

from proto_test_support import PROTO

sys.path.insert(0, str(PROTO / "tools"))
import retired as tool

OLD = "t/v1/old_service.proto"
RETIRED = {
    "files": [{"path": OLD}],
    # Entries for what the file defines are not needed, and do nothing once the file is gone.
    "methods": [{"service": "t.v1.OldService", "name": "Read"}],
    "messages": [{"message": "t.v1.ReadRequest"}],
}


def image(*, old: bool = True, importer: bool = False) -> dict[str, Any]:
    """Package t.v1: a kept file with one message, and `old` with a service and its request. `importer` adds a file
    that imports `old`."""
    files: list[dict[str, Any]] = [{"name": "t/v1/kept.proto", "package": "t.v1", "messageType": [{"name": "Kept"}]}]
    if old:
        files.append(
            {
                "name": OLD,
                "package": "t.v1",
                "messageType": [{"name": "ReadRequest"}],
                "service": [{"name": "OldService", "method": [{"name": "Read", "inputType": ".t.v1.ReadRequest"}]}],
            }
        )
    if importer:
        files.append({"name": "t/v1/importer.proto", "package": "t.v1", "dependency": [OLD]})
    return {"file": files}


class FilesTest(unittest.TestCase):
    def test_the_head_must_keep_a_retired_file_deleted(self) -> None:
        self.assertEqual(tool.head_problems(RETIRED, image(old=False)), [])
        self.assertIn(f"RETIRED_FILE_BACK {OLD} is in the head", tool.head_problems(RETIRED, image()))

    def test_the_base_loses_the_file_and_everything_it_defines(self) -> None:
        out, removed, problems = tool.without_retired(RETIRED, image())
        self.assertEqual([file["name"] for file in out["file"]], ["t/v1/kept.proto"])
        self.assertEqual(removed, [f"file {OLD}"])
        self.assertEqual(problems, [])

    def test_a_kept_file_may_not_import_it(self) -> None:
        _, _, problems = tool.without_retired(RETIRED, image(importer=True))
        self.assertEqual(problems, [f"RETIRED_FILE_IMPORTED t/v1/importer.proto imports the retired {OLD}"])

    def test_a_base_without_the_file_is_left_alone(self) -> None:
        out, removed, problems = tool.without_retired(RETIRED, image(old=False))
        self.assertEqual((out, removed, problems), (image(old=False), [], []))


FIELD = {"fields": [{"message": "t.v1.Page.Part", "name": "tree", "number": 6}]}


def page(*, tree: bool, reserved: bool = False) -> dict[str, Any]:
    """A message with a nested message whose field 6 is `tree` (`reserved` keeps 6 and the name instead)."""
    part: dict[str, Any] = {"name": "Part", "field": [{"name": "text", "number": 5}]}
    if tree:
        part["field"].append({"name": "tree", "number": 6})
    if reserved:
        part["reservedRange"] = [{"start": 6, "end": 7}]
        part["reservedName"] = ["tree"]
    return {
        "file": [
            {"name": "t/v1/page.proto", "package": "t.v1", "messageType": [{"name": "Page", "nestedType": [part]}]}
        ]
    }


class FieldsTest(unittest.TestCase):
    def test_the_head_must_keep_a_retired_field_deleted_and_reserved(self) -> None:
        self.assertEqual(tool.head_problems(FIELD, page(tree=False, reserved=True)), [])
        self.assertEqual(
            tool.head_problems(FIELD, page(tree=False)),
            ["RETIRED_FIELD_NOT_RESERVED t.v1.Page.Part.tree (6): reserve both its number and its name"],
        )
        self.assertIn(
            "RETIRED_FIELD_BACK t.v1.Page.Part.tree (6): the head has tree = 6",
            tool.head_problems(FIELD, page(tree=True)),
        )

    def test_the_base_loses_exactly_the_listed_field(self) -> None:
        out, removed, problems = tool.without_retired(FIELD, page(tree=True))
        self.assertEqual(out, page(tree=False))
        self.assertEqual((removed, problems), (["field t.v1.Page.Part.tree"], []))

    def test_another_field_with_the_number_is_a_mismatch(self) -> None:
        base = page(tree=False)
        base["file"][0]["messageType"][0]["nestedType"][0]["field"].append({"name": "other", "number": 6})
        _, removed, problems = tool.without_retired(FIELD, base)
        self.assertEqual(removed, [])
        self.assertEqual(
            problems, ["RETIRED_FIELD_MISMATCH t.v1.Page.Part.tree: the base has another name or number (other = 6)"]
        )


if __name__ == "__main__":
    unittest.main()
