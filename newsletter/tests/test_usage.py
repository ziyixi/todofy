"""Normalized per-call usage without SDK snapshots or provider events."""

import asyncio

import model_router_client as models
import pytest

import newsletter.usage as newsletter_usage
import tests.support.usage as tests_support_usage


def test_correction_adds_distinct_calls_once_and_preserves_subsets():
    records = []
    with (
        newsletter_usage.usage_scope(records.append, "synthetic"),
        newsletter_usage.model_usage("fixture") as usage,
    ):
        first = tests_support_usage.notification(100, 20)
        usage.start_turn()
        usage.observe_generation(first)
        usage.observe_generation(first)
        usage.start_turn()
        usage.observe_generation(
            tests_support_usage.notification(150, 50, 60, 20)
        )
    summary = newsletter_usage.summarize_usage(records)
    assert summary["usage"]["input_tokens"] == 250
    assert summary["usage"]["total_tokens"] == 320
    assert summary["usage"]["cached_input_tokens"] == 120
    assert not summary["partial"]
    assert records[-1]["turns_completed"] == 2


def test_unknown_is_not_zero_and_zero_report_is_known():
    records = []
    with (
        newsletter_usage.usage_scope(records.append, "synthetic"),
        newsletter_usage.model_usage("fixture") as usage,
    ):
        usage.start_turn()
        usage.observe_generation(
            models.Generation(name="requests/unknown", usage=models.Usage())
        )
    assert newsletter_usage.summarize_usage(records)["usage"] is None
    known = newsletter_usage.summarize_usage(
        tests_support_usage.record_one(
            tests_support_usage.notification(0, 0, 0, 0)
        )
    )
    assert known["usage"]["total_tokens"] == 0 and not known["partial"]


def test_missing_call_retains_known_partial_usage():
    records = []
    with (
        newsletter_usage.usage_scope(records.append, "synthetic"),
        newsletter_usage.model_usage("fixture") as usage,
    ):
        usage.start_turn()
        usage.observe_generation(tests_support_usage.notification())
        usage.start_turn()
        usage.observe_generation(models.Generation(name="requests/unknown"))
    summary = newsletter_usage.summarize_usage(records)
    assert summary["usage"]["total_tokens"] == 120 and summary["partial"]


@pytest.mark.parametrize("error", [RuntimeError, asyncio.CancelledError])
def test_interruption_flushes_known_usage_as_partial(error):
    records = []

    def interrupted():
        with (
            newsletter_usage.usage_scope(records.append, "synthetic"),
            newsletter_usage.model_usage("fixture") as usage,
        ):
            usage.start_turn()
            usage.observe_generation(tests_support_usage.notification())
            raise error()

    with pytest.raises(error):
        interrupted()
    assert newsletter_usage.summarize_usage(records)["partial"]
    assert records[-1]["status"] == "failed"


def test_no_model_call_has_no_zero_usage_placeholder():
    records = []
    with (
        newsletter_usage.usage_scope(records.append, "synthetic"),
        newsletter_usage.model_usage("fixture"),
    ):
        pass
    assert records == []


def test_sink_failure_is_safe_and_not_swallowed():
    def sink(record):
        raise RuntimeError("synthetic-private")

    with (
        pytest.raises(RuntimeError, match="usage_recording_failed"),
        newsletter_usage.usage_scope(sink, "synthetic"),
        newsletter_usage.model_usage("fixture") as usage,
    ):
        usage.start_turn()


def test_proto_json_uint64_strings_and_defaults_normalize_losslessly():
    summary = newsletter_usage.summarize_usage(tests_support_usage.record_one())
    wire = {
        **summary,
        "usage": {key: str(value) for key, value in summary["usage"].items()},
    }
    assert newsletter_usage.normalize_usage_summary(wire) == summary
    assert newsletter_usage.normalize_usage_summary({})["usage"] is None
    assert (
        newsletter_usage.normalize_usage_summary({"usage": {}})["usage"][
            "total_tokens"
        ]
        == 0
    )


@pytest.mark.parametrize(
    "bad", [True, -1, "-1", "1.2", "１", "secret", "9" * 21]
)
def test_footer_rejects_invalid_proto_json_counter(bad):
    with pytest.raises(ValueError, match=r"^invalid_usage_summary$"):
        newsletter_usage.normalize_usage_summary(
            {"usage": {"total_tokens": bad}}
        )


def test_mock_does_not_present_synthetic_usage_as_real():
    text = newsletter_usage.usage_footer(
        newsletter_usage.summarize_usage(tests_support_usage.record_one()),
        is_fixture=True,
    )
    assert "MOCK" in text and "120" not in text


def test_unknown_gemini_usage_explicitly_excluded_not_assumed_zero():
    assert "Todofy/Gemini 用量未计入" in newsletter_usage.usage_footer(
        newsletter_usage.summarize_usage(tests_support_usage.record_one())
    )
