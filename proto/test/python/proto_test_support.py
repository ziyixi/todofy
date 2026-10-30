"""Shared paths of the Python tests of proto/ (stdlib unittest; run with npm run test:python).

The tests import ``ziyixi_proto`` from proto/python/src, where tools/ensure.mjs generated the modules
(npm run test:python runs it first), exactly as an app's editable install does.
"""

import json
import sys
from pathlib import Path
from typing import Any

PROTO = Path(__file__).absolute().parents[2]
REPO = PROTO.parent
# Shared with test/wire-profile-cases.test.ts: both codecs, same verdicts and bytes.
CASES_FILE = PROTO / "testdata" / "wire-profile-cases.json"

if str(PROTO / "python" / "src") not in sys.path:
    sys.path.insert(0, str(PROTO / "python" / "src"))


def compact(value: Any) -> str:
    """The compact JSON bytes the v1 contracts send and hash."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
