"""Normalized per-call usage without SDK snapshots or provider events."""

import asyncio

import model_router_client as models
import pytest

import newsletter.errors as errors
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


_NEW_KEYS = {
    "purpose",
    "started_at",
    "finished_at",
    "requests",
    "contributing_models",
    "estimated_cost_microusd",
    "billing_kind",
    "failure",
}


def ticking_clock():
    times = iter(f"2026-10-28T14:00:{second:02d}+00:00" for second in range(60))
    return lambda: next(times)


def receipt(name, *, model="", cost=None, kind="", contributing=()):
    return models.Generation(
        name=name,
        model=model,
        contributing_models=contributing,
        usage=models.Usage(
            available=True,
            input_tokens=10,
            output_tokens=5,
            estimated_cost_microusd=cost,
            billing_kind=kind,
        ),
    )


def test_trace_keys_record_times_purpose_requests_and_cost():
    records = []
    with (
        newsletter_usage.usage_scope(
            records.append, "selection", clock=ticking_clock()
        ),
        newsletter_usage.purpose_scope("selection"),
        newsletter_usage.model_usage("requested-model") as usage,
    ):
        usage.start_turn()
        usage.bind_turn("conversations/fixture")
        usage.observe_generation(
            receipt(
                "requests/0f0e6f4e-5b1a-4c1e-9b8f-2b7d61c3a001",
                model="gpt-5.5",
                cost=120,
                kind="subscription",
                contributing=("gpt-5.5",),
            )
        )
        usage.start_turn()
        usage.observe_generation(
            receipt("requests/synthetic-2", model="openai/gpt-5.5", cost=30)
        )
    first, last = records[0], records[-1]
    assert first["started_at"] == "2026-10-28T14:00:00+00:00"
    assert "finished_at" not in first and first["requests"] == []
    assert last["started_at"] == first["started_at"]
    assert last["finished_at"] == "2026-10-28T14:00:01+00:00"
    assert last["purpose"] == "selection" and last["status"] == "completed"
    assert last["requests"] == [
        {
            "name": "requests/0f0e6f4e-5b1a-4c1e-9b8f-2b7d61c3a001",
            "model": "gpt-5.5",
        },
        {"name": "requests/synthetic-2", "model": "openai/gpt-5.5"},
    ]
    assert last["contributing_models"] == ["gpt-5.5"]
    assert last["estimated_cost_microusd"] == 150
    assert last["billing_kind"] == "subscription"
    assert "failure" not in last


def test_trace_keys_are_bounded_and_unsafe_labels_are_dropped():
    records = []
    with (
        newsletter_usage.usage_scope(records.append, "synthetic"),
        newsletter_usage.model_usage("fixture") as usage,
    ):
        # Unsafe labels come first, so no bound hides them.
        usage.start_turn()
        usage.observe_generation(
            receipt(
                "requests/../../outside",
                model="m" * 129,
                kind="Subscription <b>",
                contributing=("bad model <script>",),
            )
        )
        for number in range(newsletter_usage.MAX_REQUESTS + 2):
            usage.start_turn()
            usage.observe_generation(
                receipt(
                    f"requests/synthetic-{number}",
                    model="model-a",
                    contributing=tuple(f"model-{n}" for n in range(6)),
                )
            )
    record = records[-1]
    assert record["requests"] == [{"name": "", "model": ""}] + [
        {"name": f"requests/synthetic-{n}", "model": "model-a"}
        for n in range(newsletter_usage.MAX_REQUESTS - 1)
    ]
    assert record["contributing_models"] == [
        f"model-{n}" for n in range(newsletter_usage.MAX_MODELS)
    ]
    assert "billing_kind" not in record
    # Counters still see every call; only the trace list is bounded.
    assert record["turns_completed"] == newsletter_usage.MAX_REQUESTS + 3


def test_cost_and_billing_stay_absent_when_never_reported():
    records = tests_support_usage.record_one()
    assert "estimated_cost_microusd" not in records[-1]
    assert "billing_kind" not in records[-1]
    assert records[-1]["requests"][0]["model"] == ""


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("timeout", "timeout"),
        ("rate_limit", "rate_limit"),
        ("invalid_output", "invalid_output"),
        ("provider says no", "unavailable"),
        (None, "interrupted"),
    ],
)
def test_failure_is_a_finite_code(code, expected):
    records = []

    def failing():
        with (
            newsletter_usage.usage_scope(records.append, "synthetic"),
            newsletter_usage.model_usage("fixture") as usage,
        ):
            usage.start_turn()
            if code is not None:
                usage.fail(code)
            raise RuntimeError("synthetic")

    with pytest.raises(RuntimeError):
        failing()
    assert records[-1]["status"] == "failed"
    assert records[-1]["failure"] == expected
    assert expected in newsletter_usage.FAILURES


def test_failure_codes_cover_every_editor_category():
    # A new editor category must be kept as itself, not folded into
    # "unavailable" by a stale copy of the list.
    expected = {*errors._ERROR_MESSAGES, "interrupted"}
    assert expected == newsletter_usage.FAILURES


def test_cancellation_records_interrupted_with_finish_time():
    records = []

    def cancelled():
        with (
            newsletter_usage.usage_scope(
                records.append, "selection", clock=ticking_clock()
            ),
            newsletter_usage.model_usage("fixture") as usage,
        ):
            usage.start_turn()
            raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        cancelled()
    assert records[-1]["failure"] == "interrupted"
    assert records[-1]["finished_at"] == "2026-10-28T14:00:01+00:00"
    assert records[-1]["turns_completed"] == 0


def test_purpose_defaults_to_the_stage_node_and_rejects_unknown_labels():
    records = []
    with newsletter_usage.usage_scope(records.append, "discovery:03-world"):
        assert newsletter_usage.ModelUsage("m").record["purpose"] == "discovery"
        with newsletter_usage.purpose_scope("writer"):
            assert newsletter_usage.ModelUsage("m").record["purpose"] == (
                "writer"
            )
        assert newsletter_usage.ModelUsage("m").record["purpose"] == "discovery"
    assert newsletter_usage.ModelUsage("m").record["purpose"] == "unscoped"
    with (
        pytest.raises(ValueError, match="unknown_usage_purpose"),
        newsletter_usage.purpose_scope("anything"),
    ):
        pass


def test_mixed_old_and_new_records_keep_totals_and_footer_unchanged():
    # The final durable record of two invocations, as written now and before.
    new = [
        tests_support_usage.record_one()[-1],
        tests_support_usage.record_one(
            tests_support_usage.notification(50, 10, 5, 0)
        )[-1],
    ]
    old = [
        {key: value for key, value in record.items() if key not in _NEW_KEYS}
        for record in new
    ]
    assert all(_NEW_KEYS & set(record) for record in new)
    mixed = [old[0], new[1]]
    for records in (new, mixed):
        assert newsletter_usage.summarize_usage(
            records
        ) == newsletter_usage.summarize_usage(old)
        assert newsletter_usage.usage_footer(
            newsletter_usage.summarize_usage(records)
        ) == newsletter_usage.usage_footer(
            newsletter_usage.summarize_usage(old)
        )
