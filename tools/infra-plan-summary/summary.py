#!/usr/bin/env python3
"""Turn `tofu show -json <plan>` into a redacted summary: resource addresses and actions, nothing else.

Usage:
  tofu show -json plan.bin | python3 tools/infra-plan-summary/summary.py [--all] [--fail-on-destroy]
  python3 tools/infra-plan-summary/summary.py plan.json

Why: the JSON form of a plan carries every attribute value in plain text, including values that came
from sensitive variables (Access policy emails) and values read back from the API. ziyixi/todofy is a
public repository, so a plan's raw output must never reach a log, an issue, a commit or an artifact.
This script reads only the keys it needs (addresses and action lists) and never echoes a value, an
import id, a variable or a parse error's text. An address that does not look like a plain OpenTofu
address (for example a for_each key that is not a simple name) is withheld rather than printed.

Exit codes: 0 summary written; 2 the input is not a plan in JSON form; 3 --fail-on-destroy and the plan
deletes, replaces or forgets something (the future apply gate, infra/README.md).

Standard library only (the runner's python3). Tests: python3 -m unittest discover -s tools/infra-plan-summary
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from typing import Any, TextIO

# module.<name>. ... <type>.<name> with optional [<number>] or ["<simple key>"] after any part.
_PART = r'[A-Za-z_][A-Za-z0-9_-]*(?:\[(?:[0-9]+|"[A-Za-z0-9_.-]+")\])?'
SAFE_ADDRESS = re.compile(rf"^{_PART}(?:\.{_PART})*$")
WITHHELD = "<address withheld: unexpected characters>"

ORDER = ("import", "create", "update", "replace", "delete", "forget", "read", "no-op")
DESTRUCTIVE = {"replace", "delete", "forget"}


class NotAPlan(ValueError):
    """The input is not `tofu show -json` output for a plan. Its message never quotes the input."""


def safe_address(value: Any) -> str:
    return value if isinstance(value, str) and len(value) <= 300 and SAFE_ADDRESS.match(value) else WITHHELD


def classify(change: Any) -> str:
    """One action word for a resource change, from its "actions" list and "importing" marker only."""
    if not isinstance(change, dict):
        raise NotAPlan("a resource change has no change object")
    actions = change.get("actions")
    if not isinstance(actions, list) or not all(isinstance(a, str) for a in actions):
        raise NotAPlan("a resource change has no action list")
    importing = bool(change.get("importing"))
    key = tuple(actions)
    if key in (("delete", "create"), ("create", "delete")):
        word = "replace"
    elif key in (("no-op",), ()):
        word = "no-op"
    elif len(key) == 1 and key[0] in ("create", "update", "delete", "read", "forget"):
        word = key[0]
    else:
        word = "update"  # an unknown combination is reported as a change, never hidden as a no-op
    if importing:
        return "import" if word == "no-op" else f"import+{word}"
    return word


def summarize(plan: Any) -> dict[str, Any]:
    if not isinstance(plan, dict) or "format_version" not in plan:
        raise NotAPlan("not `tofu show -json` output")
    changes = plan.get("resource_changes") or []
    drift = plan.get("resource_drift") or []
    outputs = plan.get("output_changes") or {}
    if not isinstance(changes, list) or not isinstance(drift, list) or not isinstance(outputs, dict):
        raise NotAPlan("unexpected plan structure")
    rows = []
    for item in changes:
        if not isinstance(item, dict):
            raise NotAPlan("a resource change is not an object")
        rows.append((classify(item.get("change")), safe_address(item.get("address"))))
    drifted = []
    for item in drift:
        if not isinstance(item, dict):
            raise NotAPlan("a drift entry is not an object")
        drifted.append((classify(item.get("change")), safe_address(item.get("address"))))
    output_rows = []
    for name, change in outputs.items():
        word = classify(change)
        if word != "no-op":
            output_rows.append((word, safe_address(name)))
    return {"rows": rows, "drift": drifted, "outputs": output_rows}


def base_action(word: str) -> str:
    return word.split("+", 1)[1] if word.startswith("import+") else word


def render(summary: dict[str, Any], show_all: bool = False) -> str:
    counts = Counter()
    for word, _ in summary["rows"]:
        if word.startswith("import"):
            counts["import"] += 1
        if word != "import":
            counts[base_action(word)] += 1
    lines = [
        "### OpenTofu plan summary",
        "",
        "Addresses and actions only; no attribute, variable or import id value is ever printed.",
        "",
        ", ".join(f"{name}: {counts.get(name, 0)}" for name in ORDER),
        f"changed outside OpenTofu: {len(summary['drift'])}; output changes: {len(summary['outputs'])}",
        "",
    ]
    shown = sorted((r for r in summary["rows"] if show_all or r[0] != "no-op"), key=lambda r: (r[1], r[0]))
    if shown:
        lines += ["| Action | Address |", "| --- | --- |"]
        lines += [f"| {word} | `{address}` |" for word, address in shown]
    else:
        lines.append("No resource changes.")
    if summary["drift"]:
        lines += [
            "",
            "Changed outside OpenTofu (refresh found a difference; computed values such as a D1 file_size also"
            " count; the planned actions above are the drift signal):",
            "",
            "| Action | Address |",
            "| --- | --- |",
        ]
        lines += [f"| {word} | `{address}` |" for word, address in sorted(summary["drift"], key=lambda r: r[1])]
    if summary["outputs"]:
        lines += ["", "| Output | Action |", "| --- | --- |"]
        lines += [f"| `{name}` | {word} |" for word, name in sorted(summary["outputs"], key=lambda r: r[1])]
    return "\n".join(lines) + "\n"


def destructive(summary: dict[str, Any]) -> bool:
    return any(base_action(word) in DESTRUCTIVE for word, _ in summary["rows"])


def main(argv: list[str] | None = None, stdin: TextIO | None = None, stdout: TextIO | None = None,
         stderr: TextIO | None = None) -> int:
    stdin, stdout, stderr = stdin or sys.stdin, stdout or sys.stdout, stderr or sys.stderr
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("plan", nargs="?", help="tofu show -json output (default: stdin)")
    parser.add_argument("--all", action="store_true", help="also list resources without changes")
    parser.add_argument("--fail-on-destroy", action="store_true", help="exit 3 if anything is deleted, replaced or forgotten")
    args = parser.parse_args(argv)
    try:
        if args.plan:
            with open(args.plan, encoding="utf-8") as handle:
                text = handle.read()
        else:
            text = stdin.read()
        try:
            plan = json.loads(text)
        except ValueError:
            raise NotAPlan("input is not valid JSON") from None
        summary = summarize(plan)
    except NotAPlan as error:
        # The message is one of the fixed strings above; the input itself is never quoted.
        print(f"infra-plan-summary: {error}", file=stderr)
        return 2
    except OSError:
        print("infra-plan-summary: cannot read the plan file", file=stderr)
        return 2
    stdout.write(render(summary, show_all=args.all))
    if args.fail_on_destroy and destructive(summary):
        print("infra-plan-summary: the plan deletes, replaces or forgets a resource", file=stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
