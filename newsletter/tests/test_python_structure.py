"""Positive and negative examples for the small project structural checker."""

import pathlib

import pytest

import scripts.check_python_structure as check_python_structure


@pytest.mark.parametrize(
    "source,expected",
    [
        ("import newsletter.store", set()),
        ("from newsletter import store", set()),
        ("from typing import Any", set()),
        ("from collections.abc import Iterator", set()),
        ("from newsletter.store import Store", {"MODULE_IMPORT"}),
        (
            "from newsletter.store import _secret",
            {"MODULE_IMPORT", "PRIVATE_IMPORT"},
        ),
        ("from test_service import client", {"MODULE_IMPORT", "BOUNDARY"}),
        ("x = a if b else c if d else e", {"NESTED_TERNARY"}),
        ("x = a if b else c", set()),
        ("try:\n    f()\nexcept:\n    pass", {"BARE_EXCEPT"}),
        (
            "try:\n    f()\nexcept BaseException:\n    cleanup()\n    raise",
            set(),
        ),
        (
            (
                "try:\n"
                "    f()\n"
                "except BaseException as e:\n"
                "    if cancelled(e):\n"
                "        raise"
            ),
            {"BASE_EXCEPTION"},
        ),
        ("import newsletter.app", {"LAYER"}),
    ],
)
def test_rule_examples(source, expected):
    findings = check_python_structure.inspect_source(
        source,
        filename="src/newsletter/worker.py",
        modules={"newsletter.store"},
    )
    assert {finding.code for finding in findings} == expected


def test_handwritten_repository_boundaries():
    root = pathlib.Path(__file__).resolve().parents[1]
    modules = check_python_structure.module_names(root)
    findings = []
    for folder in ("src", "scripts", "tests"):
        for path in (root / folder).rglob("*.py"):
            relative = path.relative_to(root).as_posix()
            findings.extend(
                (relative, finding)
                for finding in check_python_structure.inspect_source(
                    path.read_text(),
                    filename=relative,
                    modules=modules,
                )
            )
    assert not findings, findings
