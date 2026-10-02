"""Opt-in real provider schema acceptance; never generate or publish an issue.

Unlike the offline startup smoke, this spends a small amount of model allowance.
It uses the configured dedicated login and production writer/reviewer schemas,
asks only for empty diagnostic envelopes, and never opens service storage.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import tempfile

import newsletter.contracts as contracts
import newsletter.editor as newsletter_editor
import newsletter.errors as errors
import newsletter.settings as newsletter_settings
import newsletter.types as types
import newsletter.usage as usage
import newsletter.workflow.components as components
import newsletter.workflow.story_editor as story_editor


def smoke_cases() -> list[tuple[str, types.Payload, types.Payload]]:
    """Return empty, nonpublishing envelopes for deployed schema variants."""
    empty: types.Payload = {
        "content": None,
        "signal": None,
        "supplemental_packets": [],
    }
    cases: list[tuple[str, types.Payload, types.Payload]] = [
        (
            "brief",
            story_editor.story_writer_schema(
                "brief", story_id="schema-acceptance"
            ),
            empty,
        ),
        (
            "deep",
            story_editor.story_writer_schema(
                "deep", story_id="schema-acceptance"
            ),
            empty,
        ),
        (
            "brief_repair",
            story_editor.story_writer_schema(
                "brief", repair=True, story_id="schema-acceptance"
            ),
            empty,
        ),
    ]
    cases.append(
        (
            "review",
            story_editor.story_review_schema(),
            {
                "prior_withdrawal": None,
                "assessments": [
                    {
                        "component": component,
                        "status": "not_present",
                        "findings": [],
                    }
                    for component in components.COMPONENTS
                ],
                "issues": [],
            },
        )
    )
    return cases


async def check_schemas(editor: newsletter_editor.CodexEditor) -> types.Payload:
    """Probe provider schema acceptance without research or publication."""
    records: dict[str, usage.UsageRecord] = {}
    checked = []
    for name, schema, expected in smoke_cases():
        with tempfile.TemporaryDirectory(
            prefix="newsletter-schema-smoke-"
        ) as temporary:
            with usage.usage_scope(
                lambda record: records.__setitem__(record["id"], record), name
            ):
                text, opened, searched = await editor.execute(
                    "Schema compatibility diagnostic only. Return this "
                    "exact empty envelope: "
                    + contracts.canonical_json(expected),
                    schema,
                    "This is a schema acceptance probe, not an editorial "
                    "task. Do not use tools, "
                    "research, read files, or invent content. Return only "
                    "the requested JSON.",
                    pathlib.Path(temporary).resolve(),
                )
            try:
                accepted = (
                    json.loads(text) == expected and not opened and not searched
                )
            except (TypeError, ValueError):
                accepted = False
            if not accepted:
                raise errors.EditorError("invalid_output")
            checked.append(name)
    return {
        "accepted": True,
        "schemas": checked,
        "usage": usage.summarize_usage(list(records.values())),
        "limitations": (
            "Schema acceptance only, not a research, fact-check, or delivery "
            "test."
        ),
    }


def main() -> None:
    """Run the opt-in model probe and expose only sanitized outcome codes."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-model-calls", action="store_true")
    args = parser.parse_args()
    if not args.allow_model_calls:
        parser.error(
            "Explicit --allow-model-calls is required; this uses model "
            "allowance."
        )
    try:
        settings = newsletter_settings.Settings.from_env()
        if settings.codex_home is None or not settings.model.strip():
            raise errors.EditorError("configuration")
        editor = newsletter_editor.CodexEditor(
            settings.codex_home, settings.model, timeout_seconds=90
        )
        print(contracts.canonical_json(asyncio.run(check_schemas(editor))))
    except errors.EditorError as error:
        raise SystemExit(
            f"Schema acceptance failed: {error.code}; "
            "no issue or email created."
        ) from None
    # Provider implementation errors must not print credentials or raw output.
    except Exception:  # noqa: BLE001
        raise SystemExit(
            "Schema acceptance failed: configuration; no issue or email "
            "created."
        ) from None


if __name__ == "__main__":
    main()
