"""Research corrections preserve normalized per-call usage receipts."""

import asyncio

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
    # Both Router traces of the one invocation, for the owner console.
    assert [request["name"] for request in records[-1]["requests"]] == [
        "requests/synthetic-1",
        "requests/synthetic-2",
    ]
    assert "failure" not in records[-1] and records[-1]["finished_at"]


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
    assert records[-1]["failure"] == "invalid_output"


@pytest.mark.parametrize(
    ("failure", "code"),
    [({"code": 8}, "rate_limit"), ({"code": 16}, "authentication")],
)
async def test_router_failure_records_its_safe_category(
    tmp_path, fake_router, failure, code
):
    fake_router.turn.failure = failure
    records = []
    with (
        pytest.raises(errors.EditorError),
        usage.usage_scope(records.append, "synthetic"),
    ):
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "synthetic", tmp_path / "workspace"
        )
    assert records[-1]["failure"] == code
    assert records[-1]["requests"] == [
        {"name": "requests/synthetic-1", "model": ""}
    ]


async def test_editor_timeout_records_timeout(tmp_path, fake_router):
    fake_router.turn.hang = True
    records = []
    with (
        pytest.raises(errors.EditorError),
        usage.usage_scope(records.append, "selection"),
    ):
        await editor.live_editor(tmp_path, timeout_seconds=0.05).execute(
            "{}", {}, "synthetic", tmp_path / "workspace"
        )
    assert records[-1]["failure"] == "timeout"
    assert records[-1]["turns_completed"] == 0


async def test_outer_cancellation_records_interrupted(tmp_path, fake_router):
    # A node budget or worker stop cancels the call from outside the editor.
    fake_router.turn.hang = True
    records = []

    async def run():
        with usage.usage_scope(records.append, "selection"):
            await editor.live_editor(tmp_path).execute(
                "{}", {}, "synthetic", tmp_path / "workspace"
            )

    task = asyncio.create_task(run())
    await fake_router.turn.started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert records[-1]["status"] == "failed"
    assert records[-1]["failure"] == "interrupted"
    assert records[-1]["purpose"] == "selection"
