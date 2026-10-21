import pytest

from todofy.core.vocab import (
    EVENT_ERROR_CODES,
    REMINDER_ERROR_CODES,
    Code,
    EventState,
    Reconcile,
    ReminderState,
    allowed_actions,
    current_codes,
)

# The codes the v2 plan added that the Worker still writes (the task codes only the releases that wrote tasks did).
V2_EVENT_CODES = {"llm_quota", "llm_budget_exhausted", "llm_request_rejected", "processing_interrupted_limit"}
# The codes of the task writes that ended on 2026-10-21.
TASK_CODES = {
    "todoist_rejected", "todoist_rate_limited", "todoist_unavailable", "todo_result_unknown", "interrupted_todo_call",
    "lookup_not_found", "lookup_failed", "lookup_ambiguous", "canary_side_effect_blocked",
    "reminder_create_failed", "reminder_result_unknown", "interrupted_reminder_call",
}  # fmt: skip


def test_states_match_the_go_ledger_check_constraints():
    """Go: mail_inbox.go:244-246 and :264 (the CHECK lists), same order."""
    assert [s.value for s in EventState] == [
        "pending", "summarizing", "summarized", "todo_sending", "todo_unknown",
        "todo_created", "complete", "ignored", "failed_summary",
    ]  # fmt: skip
    assert [s.value for s in ReminderState] == ["sending", "created", "unknown", "failed"]


def test_every_code_is_in_some_table():
    # The Chinese text lives in web/src/lib/labels.ts (labels.test.ts checks it against the OpenAPI enums).
    assert set(Code) == set(EVENT_ERROR_CODES) | set(REMINDER_ERROR_CODES)


def test_legacy_codes_are_exactly_those_only_a_retired_writer_wrote():
    legacy = {code for table in (EVENT_ERROR_CODES, REMINDER_ERROR_CODES) for code, i in table.items() if i.legacy}
    assert legacy == TASK_CODES | {
        "invalid_saved_event", "llm_client_unavailable", "summary_render_failed", "todo_client_unavailable",
        "database_client_unavailable", "cache_write_failed", "checkpoint_failed", "empty_task_id",
        "todoist_auth_blocked",  # the release that still wrote Todoist
    }  # fmt: skip
    assert V2_EVENT_CODES.issubset(current_codes(EVENT_ERROR_CODES))
    # Go codes the Worker still writes, so imported and new rows read the same.
    assert {"mail_needs_review", "summary_failed", "dismissed_by_owner"} <= current_codes(EVENT_ERROR_CODES)
    assert current_codes(REMINDER_ERROR_CODES) == set()


@pytest.mark.parametrize(
    ("state", "code", "expected"),
    [
        # A row of the task writes (none are left after migration 0014) may only be dismissed.
        ("todo_unknown", "todo_result_unknown", ["dismiss"]),
        ("failed_summary", "summary_failed", ["retry_summary", "dismiss"]),
        ("failed_summary", "processing_interrupted_limit", ["retry_summary", "dismiss"]),
        ("failed_summary", "mail_needs_review", ["dismiss"]),
        ("pending", "llm_quota", []),
        ("summarized", "todoist_rejected", []),
        ("todo_created", "", []),
        ("complete", "", []),
        ("ignored", "dismissed_by_owner", []),
    ],
)
def test_allowed_owner_actions(state, code, expected):
    """Go: handleReconcile's WHERE clauses (mail_inbox_worker.go:726-767)."""
    assert [a.value for a in allowed_actions(state, code)] == expected


def test_needs_review_cannot_be_retried_into_side_effects():
    """Go: mail_content_policy_test.go:98 TestMailNeedsReviewIsDurableAndCannotRetryIntoBusinessSideEffects."""
    assert Reconcile.RETRY_SUMMARY not in allowed_actions(EventState.FAILED_SUMMARY, Code.MAIL_NEEDS_REVIEW)
    for state in EventState:
        assert Reconcile.RETRY_SUMMARY not in allowed_actions(state, Code.MAIL_NEEDS_REVIEW)


@pytest.mark.parametrize("state", list(EventState))
def test_a_canary_offers_no_owner_action(state):
    """contracts/ops-v1: a canary ends by itself."""
    for code in ("", "todo_result_unknown", "summary_failed", "todoist_rejected"):
        assert allowed_actions(state, code, canary=True) == ()
