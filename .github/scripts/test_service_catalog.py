"""Changes runs catalog checks without adding credentials or deployment rights."""

import os
import sys
import unittest
from pathlib import Path

if sys.version_info < (3, 11) and os.environ.get("GITHUB_ACTIONS") != "true":
    raise unittest.SkipTest("The service catalog requires Python 3.11+; use uv run --no-project --python 3.12")


def load_tests(loader, tests, pattern):
    directory = Path(__file__).resolve().parents[2] / "tools/service-catalog/tests"
    return loader.discover(str(directory), pattern="test_*.py", top_level_dir=str(directory))
