import pytest

from todofy.core.classify import Failure, HttpOutcome, classify_gemini
from todofy.core.vocab import EVENT_ERROR_CODES, current_codes

TIMEOUT = HttpOutcome(failure=Failure.TIMEOUT)
LOST = HttpOutcome(failure=Failure.LOST)
NOT_SENT = HttpOutcome(failure=Failure.NOT_SENT)


def status(code: int, retry_after: float = 0.0) -> HttpOutcome:
    return HttpOutcome(status=code, retry_after=retry_after)


def test_outcome_needs_exactly_one_of_status_and_failure():
    with pytest.raises(ValueError):
        HttpOutcome()
    with pytest.raises(ValueError):
        HttpOutcome(status=500, failure=Failure.LOST)


@pytest.mark.parametrize(
    ("outcome", "text", "ok", "code", "next_model"),
    [
        (status(200), "摘要", True, None, False),
        (status(200), "  \n", False, "summary_failed", True),
        (status(200), None, False, "summary_failed", True),
        (status(429, 30), None, False, "llm_quota", True),
        (status(500), None, False, "summary_failed", True),
        (status(503), None, False, "summary_failed", True),
        (TIMEOUT, None, False, "summary_failed", True),
        (LOST, None, False, "summary_failed", True),
        (NOT_SENT, None, False, "summary_failed", True),
        (status(400), None, False, "llm_request_rejected", False),
        (status(401), None, False, "llm_request_rejected", False),
        (status(403), None, False, "llm_request_rejected", False),
        (status(404), None, False, "llm_request_rejected", True),
    ],
)
def test_gemini(outcome, text, ok, code, next_model):
    verdict = classify_gemini(outcome, text)
    assert (verdict.ok, verdict.code, verdict.next_model) == (ok, code, next_model)


def test_gemini_quota_keeps_retry_after():
    assert classify_gemini(status(429, 42), None).retry_after == 42


def test_the_classifier_only_writes_current_codes():
    outcomes = [status(s) for s in (200, 301, 400, 401, 403, 404, 408, 429, 500, 502, 503, 504)]
    outcomes += [TIMEOUT, LOST, NOT_SENT]
    assert {classify_gemini(o, None).code for o in outcomes} - {None} <= current_codes(EVENT_ERROR_CODES)
