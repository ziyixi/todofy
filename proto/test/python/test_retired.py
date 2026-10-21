"""tools/retired.py's `files` kind on synthetic buf images (JSON form), next to the module's own self-test
(scripts/rules-selftest.sh, which deletes real .proto files): a retired file stays out of the head, leaves the base
with everything it defines, and may not be imported by a file the base keeps.
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


if __name__ == "__main__":
    unittest.main()
