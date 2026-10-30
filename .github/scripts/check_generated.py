"""Check the existing generated public configuration without changing it."""

import sys

from audit_workspace import stage

root = stage(sys.argv[1])
sys.path[:0] = [str(root / "tools/cloud-config"), str(root / "tools/service-catalog")]
import catalog
import generate
import inventory

if generate.main(["--check"]) or catalog.main(["--check"]):
    raise SystemExit(1)
sys.argv[:] = ["inventory.py", "--check"]
raise SystemExit(inventory.main())
