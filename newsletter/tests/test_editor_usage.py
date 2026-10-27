"""Research corrections preserve normalized per-call usage receipts."""

import model_router_client as models
import pytest

import newsletter.errors as errors
import newsletter.usage as usage
import tests.support.editor as editor


async def test_correction_reuses_context_and_adds_per_call_usage(
    tmp_path, fake_router, packet
):
    value = {"packets": [packet["content"]]}
    first = editor.FakeTurn(value, research=False)
    first.usage = models.Usage(
        available=True, input_tokens=100, output_tokens=20
    )
    second = editor.FakeTurn(value)
    second.usage = models.Usage(
        available=True, input_tokens=150, output_tokens=50
    )
    fake_router.turns = [first, second]
    records = []
    with usage.usage_scope(records.append, "synthetic"):
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "synthetic", tmp_path / "workspace"
        )
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 2
    assert usage.summarize_usage(records)["usage"]["total_tokens"] == 320
    assert records[-1]["turns_started"] == 2


async def test_bad_output_retains_known_usage(tmp_path, fake_router):
    fake_router.turn.bundle = "not JSON"
    fake_router.turn.usage = models.Usage(
        available=True, input_tokens=100, output_tokens=20
    )
    records = []
    with (
        pytest.raises(errors.EditorError),
        usage.usage_scope(records.append, "synthetic"),
    ):
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "synthetic", tmp_path / "workspace"
        )
    assert usage.summarize_usage(records)["usage"]["total_tokens"] == 120
    assert records[-1]["status"] == "failed"
