"""Stdlib import bridge for cross-app checks of the public configuration generator."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools/cloud-config"))
from generate import platform_identity  # noqa: E402,F401
