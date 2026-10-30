"""Run the declared unittest module, including files without a main guard."""

import importlib
import sys
import unittest

if __name__ == "__main__":
    module = importlib.import_module(sys.argv[1])
    suite = unittest.defaultTestLoader.loadTestsFromModule(module)
    if not suite.countTestCases():
        raise SystemExit("The declared unittest module contains no tests")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
