"""The migration scripts import each other as plain modules, as they do when run from this directory."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
