"""Resolve the checked CI caller and its reusable release recipe for safety tests."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def jobs(text):
    body = text.split("\njobs:\n", 1)[1]
    parts = re.split(r"^  ([a-z][a-z0-9-]*):\n", body, flags=re.M)
    return dict(zip(parts[1::2], parts[2::2], strict=True))


def effective_ci():
    source = (ROOT / ".github/workflows/ci.yml").read_text()
    release = jobs((ROOT / ".github/workflows/worker-release.yml").read_text())
    for name, caller in jobs(source).items():
        if "uses: ./.github/workflows/worker-release.yml" not in caller:
            continue
        if name not in release:
            raise ValueError("Reusable release job missing")
        checked = caller.split("    permissions:\n", 1)[0]
        recipe = "    runs-on:" + release[name].split("    runs-on:", 1)[1]
        # Existing test fixtures execute shell steps against the fixture root, not a nested checkout.
        recipe = recipe.replace(".release-source/", "").replace("working-directory: .release-source\n", "working-directory: .\n")
        source = source.replace("  " + name + ":\n" + caller, "  " + name + ":\n" + checked + recipe)
    return source
