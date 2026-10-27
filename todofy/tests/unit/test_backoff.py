from datetime import UTC, datetime

import pytest

from todofy.core import backoff
from todofy.core.backoff import (
    DAY,
    parse_retry_after,
    postpone_delay,
    retry_delay,
    summary_gives_up,
)

NOW = datetime(2026, 9, 27, 12, 0, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("attempts", "minutes"),
    [(-1, 1), (0, 1), (1, 2), (2, 4), (5, 32), (8, 256), (9, 256), (40, 256)],
)
def test_retry_delay_doubles_from_one_minute_and_caps_at_256(attempts, minutes):
    """Go: mailRetryDelay (mail_inbox_worker.go:75-87)."""
    assert retry_delay(attempts) == minutes * 60


def test_retry_delay_base_is_configurable_for_runtime_tests():
    assert retry_delay(3, base=0.2) == pytest.approx(1.6)


@pytest.mark.parametrize(
    ("code", "attempts", "age_days", "gives_up"),
    [
        ("summary_failed", 12, 6, False),
        ("summary_failed", 12, 8, True),
        ("summary_failed", 11, 8, False),
        ("llm_quota", 30, 1, False),
        ("llm_quota", 12, 8, True),
        ("llm_request_rejected", 12, 0, True),
        ("llm_request_rejected", 11, 0, False),
        ("llm_budget_exhausted", 500, 30, False),
    ],
)
def test_transient_summary_failures_retry_for_seven_days(code, attempts, age_days, gives_up):
    """Go: mail_inbox_attention_test.go:223 TestMailInboxTransientSummaryFailuresRetryForSevenDays.

    The Go rows for llm_client_unavailable map to llm_quota (the transient code
    that replaces it) and invalid_saved_event to llm_request_rejected (attempt rule).
    """
    assert summary_gives_up(attempts, code, age_days * DAY) is gives_up


def test_postpone_honours_retry_after_within_a_day():
    assert postpone_delay(0) == 60
    assert postpone_delay(0, retry_after=900) == 900
    assert postpone_delay(8, retry_after=900) == 256 * 60
    assert postpone_delay(0, retry_after=10 * DAY) == DAY


@pytest.mark.parametrize(
    ("header", "seconds"),
    [
        (None, 0),
        ("", 0),
        ("120", 120),
        (" 7 ", 7),
        ("+5", 5),
        ("0", 0),
        ("-5", 0),
        ("1_000", 0),
        ("soon", 0),
        ("Sun, 27 Sep 2026 12:01:30 GMT", 90),
        ("Sunday, 27-Sep-26 12:00:45 GMT", 45),
        ("Sun Sep 27 12:02:00 2026", 120),
        ("Mon Oct  5 12:00:00 2026", 8 * DAY),
        ("Sun, 27 Sep 2026 11:00:00 GMT", 0),
    ],
)
def test_retry_after_seconds_and_http_dates(header, seconds):
    """Go: parseRetryAfter (todo/internal/todoist/client.go:486-507)."""
    assert parse_retry_after(header, NOW) == seconds


def test_budgets_are_the_v2_values():
    assert (backoff.GEMINI_MODEL_TIMEOUT, backoff.GEMINI_STEP_BUDGET) == (60, 180)
    assert backoff.SUMMARY_RETRY_WINDOW == 7 * DAY
