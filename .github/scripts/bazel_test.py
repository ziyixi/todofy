"""Run the existing repository audit suite on declared sources."""

import sys
import unittest

from audit_workspace import stage

root = stage(sys.argv[1], git_index=True)
suite = unittest.defaultTestLoader.discover(str(root / ".github/scripts"))
if not suite.countTestCases():
    raise SystemExit("The declared repository audit suite contains no tests")
result = unittest.TextTestRunner(verbosity=1).run(suite)
raise SystemExit(not result.wasSuccessful())
