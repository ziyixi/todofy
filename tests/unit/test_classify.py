import pytest

from todofy.core.classify import (
    Failure,
    HttpOutcome,
    classify_gemini,
    classify_lookup,
    classify_reminder,
    classify_task_create,
    final_task_verdict,
)
from todofy.core.vocab import EVENT_ERROR_CODES, REMINDER_ERROR_CODES, current_codes

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


@pytest.mark.parametrize(
    ("outcome", "task_id", "result", "state", "code", "inline"),
    [
        (status(200), "123", "created", "complete", None, False),
        (status(200), "", "unknown", "todo_unknown", "todo_result_unknown", False),
        (status(400), "", "retry_later", "summarized", "todoist_rejected", False),
        (status(404), "", "retry_later", "summarized", "todoist_rejected", False),
        (status(401), "", "blocked", "summarized", "todoist_auth_blocked", False),
        (status(403), "", "blocked", "summarized", "todoist_auth_blocked", False),
        (status(429, 5), "", "retry_later", "summarized", "todoist_rate_limited", True),
        (status(502), "", "retry_later", "summarized", "todoist_unavailable", True),
        (status(503), "", "retry_later", "summarized", "todoist_unavailable", True),
        (status(504), "", "retry_later", "summarized", "todoist_unavailable", True),
        (status(500), "", "unknown", "todo_unknown", "todo_result_unknown", False),
        (status(501), "", "unknown", "todo_unknown", "todo_result_unknown", False),
        (TIMEOUT, "", "unknown", "todo_unknown", "todo_result_unknown", True),
        (LOST, "", "unknown", "todo_unknown", "todo_result_unknown", False),
        (NOT_SENT, "", "retry_later", "summarized", "todoist_unavailable", False),
    ],
)
def test_todoist_task_creation(outcome, task_id, result, state, code, inline):
    verdict = classify_task_create(outcome, task_id)
    assert (verdict.result, verdict.state, verdict.code, verdict.retry_inline) == (result, state, code, inline)


def test_todoist_rate_limit_keeps_retry_after():
    assert classify_task_create(status(429, 7), "").retry_after == 7


def _call(*attempts: tuple[HttpOutcome, str]):
    """The verdict of one create call made of these attempts, as runtime/todoist.create_task combines them."""
    verdicts = [classify_task_create(outcome, task_id) for outcome, task_id in attempts]
    delivered = any(verdict.result == "unknown" for verdict in verdicts)
    return final_task_verdict(verdicts[-1], delivered)


@pytest.mark.parametrize(
    ("attempts", "result", "code"),
    [
        # A timed-out attempt may have created the task: never an automatic resend afterwards.
        ([(TIMEOUT, ""), (status(503), "")], "unknown", "todo_result_unknown"),
        ([(TIMEOUT, ""), (status(429, 3), ""), (status(429, 3), "")], "unknown", "todo_result_unknown"),
        ([(TIMEOUT, ""), (TIMEOUT, ""), (status(502), "")], "unknown", "todo_result_unknown"),
        ([(TIMEOUT, ""), (status(401), "")], "unknown", "todo_result_unknown"),
        ([(TIMEOUT, ""), (status(400), "")], "unknown", "todo_result_unknown"),
        ([(TIMEOUT, ""), (status(200), "t1")], "created", None),
        ([(TIMEOUT, ""), (TIMEOUT, ""), (TIMEOUT, "")], "unknown", "todo_result_unknown"),
        # Nothing could have been created: the last verdict stands.
        ([(status(503), ""), (status(503), ""), (status(503), "")], "retry_later", "todoist_unavailable"),
        ([(status(429, 1), ""), (status(401), "")], "blocked", "todoist_auth_blocked"),
    ],
)
def test_a_call_that_may_have_created_the_task_ends_created_or_unknown(attempts, result, code):
    verdict = _call(*attempts)
    assert (verdict.result, verdict.code) == (result, code)


@pytest.mark.parametrize(
    ("outcome", "task_id", "state", "code"),
    [
        (status(200), "r1", "created", None),
        (status(200), "", "unknown", "reminder_result_unknown"),
        (NOT_SENT, "", "failed", "reminder_create_failed"),
        (status(400), "", "failed", "reminder_create_failed"),
        (status(401), "", "failed", "reminder_create_failed"),
        (status(403), "", "failed", "reminder_create_failed"),
        (status(404), "", "failed", "reminder_create_failed"),
        (status(429), "", "failed", "reminder_create_failed"),
        (status(502), "", "failed", "reminder_create_failed"),
        (status(503), "", "failed", "reminder_create_failed"),
        (status(504), "", "failed", "reminder_create_failed"),
        (status(500), "", "unknown", "reminder_result_unknown"),
        (TIMEOUT, "", "unknown", "reminder_result_unknown"),
        (LOST, "", "unknown", "reminder_result_unknown"),
    ],
)
def test_reminder(outcome, task_id, state, code):
    """Go: mailReminderOutcome (mail_inbox_worker.go:633-645) recast as HTTP results;
    see mail_inbox_attention_test.go:481/:561 for the retry rules the runtime applies."""
    verdict = classify_reminder(outcome, task_id)
    assert (verdict.state, verdict.code) == (state, code)


@pytest.mark.parametrize(
    ("matches", "state", "code"),
    [
        (None, "todo_unknown", "lookup_failed"),
        (0, "todo_unknown", "lookup_not_found"),
        (1, "todo_created", None),
        (2, "todo_unknown", "lookup_ambiguous"),
    ],
)
def test_footer_lookup(matches, state, code):
    assert classify_lookup(matches) == (state, code)


def test_classifiers_only_write_current_codes():
    outcomes = [status(s) for s in (200, 301, 400, 401, 403, 404, 408, 429, 500, 502, 503, 504)]
    outcomes += [TIMEOUT, LOST, NOT_SENT]
    event_codes = {classify_gemini(o, None).code for o in outcomes}
    event_codes |= {classify_task_create(o, "").code for o in outcomes}
    event_codes |= {classify_lookup(n)[1] for n in (None, 0, 1, 2)}
    reminder_codes = {classify_reminder(o, "").code for o in outcomes}
    assert event_codes - {None} <= current_codes(EVENT_ERROR_CODES)
    assert reminder_codes - {None} <= current_codes(REMINDER_ERROR_CODES)
