"""Exercise production _collect with the pinned SDK's real event data models."""

import asyncio
import json
import types

import openai_codex.generated.v2_all as v2_all
import openai_codex.models as models
import pytest

import newsletter.editor as newsletter_editor
import newsletter.errors as newsletter_errors
import newsletter.usage as newsletter_usage
import tests.support.editor as editor
import tests.support.usage as tests_support_usage


class EventTurn:
    def __init__(self, events):
        self.events = events

    async def stream(self):
        for event in self.events:
            if isinstance(event, BaseException):
                raise event
            yield event


def usage_event():

    payload = v2_all.ThreadTokenUsageUpdatedNotification.model_validate(
        tests_support_usage.notification()
    )
    return models.Notification(
        method="thread/tokenUsage/updated", payload=payload
    )


def final_event():
    return types.SimpleNamespace(
        method="item/completed",
        payload={
            "item": {
                "type": "agentMessage",
                "phase": "final_answer",
                "text": json.dumps({"synthetic": True}),
            }
        },
    )


def end_event(status="completed"):
    return types.SimpleNamespace(
        method="turn/completed", payload={"turn": {"status": status}}
    )


async def test_collect_captures_real_sdk_usage_without_changing_return_tuple():
    records = []
    with (
        newsletter_usage.usage_scope(records.append, "editor"),
        newsletter_usage.codex_usage("fixture") as usage,
    ):
        usage.start_turn()
        result = await newsletter_editor._collect(
            EventTurn([usage_event(), final_event(), end_event()])
        )
    assert result == ('{"synthetic": true}', set(), False)
    assert (
        newsletter_usage.summarize_usage(records)["usage"]["total_tokens"]
        == 120
    )
    assert not newsletter_usage.summarize_usage(records)["partial"]


@pytest.mark.parametrize(
    "ending",
    [end_event("failed"), RuntimeError("fixture"), asyncio.CancelledError()],
)
async def test_collect_keeps_reported_usage_even_when_stream_fails(ending):
    records = []
    error = (
        type(ending)
        if isinstance(ending, BaseException)
        else newsletter_errors.EditorError
    )

    async def collect_with_usage():
        with (
            newsletter_usage.usage_scope(records.append, "research:fixture"),
            newsletter_usage.codex_usage("fixture") as usage,
        ):
            usage.start_turn()
            await newsletter_editor._collect(EventTurn([usage_event(), ending]))

    with pytest.raises(error):
        await collect_with_usage()
    assert (
        newsletter_usage.summarize_usage(records)["usage"]["total_tokens"]
        == 120
    )
    assert newsletter_usage.summarize_usage(records)["partial"]


async def test_no_usage_event_is_unknown_not_an_empty_successful_measurement():
    records = []
    with (
        newsletter_usage.usage_scope(records.append, "editor"),
        newsletter_usage.codex_usage("fixture") as usage,
    ):
        usage.start_turn()
        await newsletter_editor._collect(
            EventTurn([final_event(), end_event()])
        )
    assert newsletter_usage.summarize_usage(records)["usage"] is None


async def test_execute_captures_original_provenance_correction_as_one_thread(
    tmp_path, fake_sdk, packet
):
    research = {
        "state": "collected",
        "note": "synthetic",
        "packets": [packet["content"]],
    }

    class MeteredTurn(editor.FakeTurn):
        def __init__(self, tokens, research_enabled):
            super().__init__(research, research=research_enabled)
            self.tokens = tokens

        async def stream(self):
            yield types.SimpleNamespace(
                method="thread/tokenUsage/updated",
                payload=tests_support_usage.notification(self.tokens),
            )
            async for event in super().stream():
                yield event

    fake_sdk.turns = [MeteredTurn(100, False), MeteredTurn(300, True)]
    records = []
    with newsletter_usage.usage_scope(records.append, "research:synthetic"):
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "synthetic", tmp_path / "workspace"
        )
    assert len(fake_sdk.prompts) == 2
    assert newsletter_usage.summarize_usage(records)["invocations"] == 1
    assert (
        newsletter_usage.summarize_usage(records)["usage"]["total_tokens"]
        == 320
    )
    assert records[-1]["turns_started"] == 2


async def test_invalid_model_result_still_has_reported_usage(
    tmp_path, fake_sdk
):
    class InvalidTurn(editor.FakeTurn):
        async def stream(self):
            yield usage_event()
            async for event in super().stream():
                yield event

    fake_sdk.turn = InvalidTurn("not JSON", research=False)
    records = []
    with (
        pytest.raises(newsletter_errors.EditorError),
        newsletter_usage.usage_scope(records.append, "editor"),
    ):
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "synthetic", tmp_path / "workspace"
        )
    assert (
        newsletter_usage.summarize_usage(records)["usage"]["total_tokens"]
        == 120
    )
    assert records[-1]["status"] == "failed"
