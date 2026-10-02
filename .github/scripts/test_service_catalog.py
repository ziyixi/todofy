"""Changes runs catalog checks without adding credentials or deployment rights."""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

if sys.version_info < (3, 11) and os.environ.get("GITHUB_ACTIONS") != "true":
    raise unittest.SkipTest("The service catalog requires Python 3.11+; use uv run --no-project --python 3.12")


def load_tests(loader, tests, pattern):
    directory = Path(__file__).resolve().parents[2] / "tools/service-catalog/tests"
    # Nested discovery changes a loader's top-level directory. The outer loader
    # must retain its own directory so it can continue with sibling CI tests.
    catalog_tests = unittest.TestLoader().discover(
        str(directory), pattern="test_*.py", top_level_dir=str(directory)
    )
    return unittest.TestSuite((tests, catalog_tests))


class CatalogDiscoveryBridgeTests(unittest.TestCase):
    def test_outer_loader_can_continue_discovery_after_catalog_hook(self):
        with tempfile.TemporaryDirectory() as temporary:
            sibling = Path(temporary) / "test_catalog_bridge_followup.py"
            sibling.write_text(
                "import unittest\n"
                "class FollowupTests(unittest.TestCase):\n"
                "    def test_followup(self):\n"
                "        pass\n"
            )
            outer_loader = unittest.TestLoader()
            before = outer_loader.discover(temporary, pattern=sibling.name)
            self.addCleanup(sys.modules.pop, sibling.stem, None)
            self.assertEqual(before.countTestCases(), 1)

            with mock.patch.object(outer_loader, "discover", wraps=outer_loader.discover) as nested:
                load_tests(outer_loader, unittest.TestSuite(), "test_*.py")
                nested.assert_not_called()

            after = outer_loader.discover(temporary, pattern=sibling.name)
            self.assertEqual(after.countTestCases(), 1)
            self.assertEqual(outer_loader.errors, [])
