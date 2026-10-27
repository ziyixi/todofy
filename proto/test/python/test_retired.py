"""tools/retired.py's `files` and `fields` kinds on synthetic buf images (JSON form), next to the module's own
self-test (scripts/rules-selftest.sh, which deletes real .proto files): a retired file stays out of the head, leaves
the base with everything it defines, and may not be imported by a file the base keeps; a retired field stays out of
the head with its number and name reserved, and takes with it the import that only it used.
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


GONE = "g/v1/gone.proto"
FIELD = {"packages": [{"path": "g/v1/", "package": "g.v1"}], "fields": [{"field": "k.v1.Status.gone", "number": 3}]}


def status(*, gone: bool = True, also: bool = False) -> dict[str, Any]:
    """k.v1.Status with two proto3 `optional` fields; `gone` (3) uses g.v1.Gone, which `also` uses a second time."""
    fields: list[dict[str, Any]] = [
        {"name": "kept", "number": 1, "proto3Optional": True, "oneofIndex": 0},
        {"name": "later", "number": 2, "proto3Optional": True, "oneofIndex": 1},
    ]
    oneofs = [{"name": "_kept"}, {"name": "_later"}]
    if gone:
        fields.insert(
            1, {"name": "gone", "number": 3, "typeName": ".g.v1.Gone", "proto3Optional": True, "oneofIndex": 1}
        )
        fields[2]["oneofIndex"] = 2
        oneofs.insert(1, {"name": "_gone"})
    if also:
        fields.append({"name": "also", "number": 4, "typeName": ".g.v1.Gone"})
    return {
        "file": [
            {"name": GONE, "package": "g.v1", "messageType": [{"name": "Gone"}]},
            {
                "name": "k/v1/status.proto",
                "package": "k.v1",
                "dependency": [GONE],
                "messageType": [{"name": "Status", "field": fields, "oneofDecl": oneofs}],
            },
        ]
    }


class FieldsTest(unittest.TestCase):
    def test_the_head_keeps_a_retired_field_deleted_with_its_number_and_name_reserved(self) -> None:
        retired = {"fields": FIELD["fields"]}
        head = status(gone=False)
        message = head["file"][1]["messageType"][0]
        problems = tool.head_problems(retired, head)
        self.assertEqual(
            problems, ["RETIRED_FIELD_NOT_RESERVED k.v1.Status.gone (3): reserve both its number and its name"]
        )
        message.update(reservedRange=[{"start": 3, "end": 4}], reservedName=["gone"])
        self.assertEqual(tool.head_problems(retired, head), [])
        self.assertIn("RETIRED_FIELD_BACK", tool.head_problems(retired, status())[0])

    def test_the_base_loses_the_field_its_synthetic_oneof_and_the_import_only_it_used(self) -> None:
        out, removed, problems = tool.without_retired(FIELD, status())
        self.assertEqual(problems, [])
        self.assertEqual(removed, ["package g.v1", "field k.v1.Status.gone", f"import {GONE} of k/v1/status.proto"])
        (kept,) = out["file"]
        message = kept["messageType"][0]
        self.assertEqual(kept["dependency"], [])
        self.assertEqual([(f["name"], f["oneofIndex"]) for f in message["field"]], [("kept", 0), ("later", 1)])
        self.assertEqual(message["oneofDecl"], [{"name": "_kept"}, {"name": "_later"}])

    def test_an_import_another_kept_field_still_uses_is_an_error(self) -> None:
        _, _, problems = tool.without_retired(FIELD, status(also=True))
        self.assertEqual(problems, [f"RETIRED_PACKAGE_IMPORTED k/v1/status.proto imports the retired {GONE}"])


if __name__ == "__main__":
    unittest.main()
