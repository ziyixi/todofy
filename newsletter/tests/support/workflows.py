"""Parse CI behavior independently of YAML spelling and indentation."""

import pathlib
from typing import Any

import yaml

ROOT = pathlib.Path(__file__).absolute().parents[3]


def load(name: str) -> dict[str, Any]:
    """Load a workflow while preserving GitHub's on key and scalar strings."""
    value: object = yaml.load(
        (ROOT / ".github/workflows" / name).read_text(),
        Loader=yaml.BaseLoader,
    )
    assert isinstance(value, dict)
    # Follow composite commands without changing native job gates/permissions.
    # The root guards check input wiring; these tests check order and tools.
    for job in value.get("jobs", {}).values():
        if "steps" not in job:
            continue
        expanded = []
        for step in job["steps"]:
            action = step.get("uses", "")
            if action.startswith("./.github/actions/"):
                recipe = yaml.load(
                    (ROOT / action / "action.yml").read_text(),
                    Loader=yaml.BaseLoader,
                )
                assert recipe["runs"]["using"] == "composite"
                expanded.extend(recipe["runs"]["steps"])
            else:
                expanded.append(step)
        job["steps"] = expanded
    return value
