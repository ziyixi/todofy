"""Parse CI behavior independently of YAML spelling and indentation."""

import pathlib
from typing import Any

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[3]


def load(name: str) -> dict[str, Any]:
    """Load a workflow while preserving GitHub's on key and scalar strings."""
    value: object = yaml.load(
        (ROOT / ".github/workflows" / name).read_text(),
        Loader=yaml.BaseLoader,
    )
    assert isinstance(value, dict)
    # Keep native job gates/permissions while following the commands in local composites.
    # Input wiring is checked by the root CI guards; these tests check command order and tools.
    for job in value.get("jobs", {}).values():
        if "steps" not in job:
            continue
        expanded = []
        for step in job["steps"]:
            action = step.get("uses", "")
            if action.startswith("./.github/actions/"):
                recipe = yaml.load(
                    (ROOT / action / "action.yml").read_text(), Loader=yaml.BaseLoader
                )
                assert recipe["runs"]["using"] == "composite"
                expanded.extend(recipe["runs"]["steps"])
            else:
                expanded.append(step)
        job["steps"] = expanded
    return value
