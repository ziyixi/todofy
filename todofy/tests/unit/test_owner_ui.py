"""core/owner_ui.py: todofy.ui.v1's request rules, cursors and the mapping from the ledger's dicts to the generated
messages (proto/todofy/ui/v1), and the IDL's enums against core/vocab.py."""

import json
import re
from pathlib import Path

import pytest
from ziyixi_proto.todofy.ui.v1 import history_pb, mail_event_pb, reports_pb, status_pb
from ziyixi_proto.wire_json import from_wire, wire_name

from todofy.core import owner_ui as ui
from todofy.core.owner_ui import Reason, UiError
from todofy.core.sql import ACTIVE_STATES
from todofy.core.vocab import (
    EVENT_ERROR_CODES,
    REMINDER_ERROR_CODES,
    EventState,
    Reconcile,
    ReminderState,
)

EVENT = "0b8f5a4e-3c1d-4c52-9f0e-2d7c8b6a5f41"
AT = "2026-09-28T08:00:00Z"


def names(cls) -> set[str]:
    return {name for member in cls if (name := wire_name(member)) is not None}


def refused(reason: Reason):
    return pytest.raises(UiError, match=f"^{reason}$")


class TestVocabulary:
    """The IDL's enums name exactly what the ledger writes, so every row maps to a value (never UNSPECIFIED)."""

    def test_event_states(self):
        assert names(mail_event_pb.MailEvent_State) == set(EventState)

    def test_event_error_codes(self):
        assert names(mail_event_pb.EventErrorCode) == set(EVENT_ERROR_CODES)

    def test_reconcile_actions(self):
        assert names(mail_event_pb.ReconcileAction) == set(Reconcile)

    def test_reminder_states_and_codes(self):
        assert names(status_pb.DailyReminder_State) == set(ReminderState)
        assert names(status_pb.ReminderErrorCode) == set(REMINDER_ERROR_CODES)

    def test_review_states_are_the_reminder_states(self):
        assert names(history_pb.GtdReview_State) == set(ReminderState)

    def test_transition_actors_match_the_migration_check(self):
        migration = (Path(__file__).parents[2] / "migrations" / "0001_init.sql").read_text()
        actors = re.search(r"CHECK \(actor IN \(([^)]*)\)\)", migration).group(1)
        assert names(mail_event_pb.Transition_Actor) == set(re.findall(r"'([^']*)'", actors))

    def test_active_counts_name_every_active_state(self):
        fields = {name.removesuffix("_count") for name in status_pb.ActiveCounts.__dataclass_fields__}
        assert fields == set(ACTIVE_STATES)


class TestRequests:
    def test_page_size_follows_aip_158(self):
        assert ui.page_size(0, 50, 100) == 50
        assert ui.page_size(7, 50, 100) == 7
        assert ui.page_size(1000, 50, 100) == 100
        with refused(Reason.BAD_REQUEST):
            ui.page_size(-1, 50, 100)

    def test_event_names(self):
        assert ui.event_id(f"mailEvents/{EVENT}") == EVENT
        with refused(Reason.NOT_FOUND):
            ui.event_id("mailEvents/not-a-uuid")
        with refused(Reason.BAD_REQUEST):
            ui.event_id(f"events/{EVENT}")

    def test_legacy_text_names(self):
        assert ui.legacy_key(f"legacyTexts/{EVENT}") == EVENT
        # An imported cache row without an event stays in D1 only (AIP-122: no `:` in an ID).
        for name in ("legacyTexts/legacy:row-12", "legacyTexts/legacy:", "legacyTexts/legacy-abc"):
            with refused(Reason.NOT_FOUND):
                ui.legacy_key(name)

    def test_etag_is_a_version(self):
        assert ui.etag_version("5") == 5
        for stale in ("", "0", "05", "v5", "5.0", str(2**53)):
            with refused(Reason.ETAG_MISMATCH):
                ui.etag_version(stale)

    def test_event_filter_is_one_restriction(self):
        assert ui.event_filter("") == (None, False)
        assert ui.event_filter("  ") == (None, False)
        assert ui.event_filter("state = TODO_UNKNOWN") == ("todo_unknown", False)
        assert ui.event_filter("state=COMPLETE") == ("complete", False)
        assert ui.event_filter(" attention = true ") == (None, True)
        for bad in (
            "state = todo_unknown",
            "state = UNSPECIFIED",
            "state = SLEEPING",
            "attention = false",
            "attention = TRUE",
            "state = PENDING AND attention = true",
            "state = PENDING OR state = COMPLETE",
            "state != PENDING",
            "subject = x",
            "PENDING",
            "state = " + "A" * 64,
        ):
            with refused(Reason.BAD_REQUEST):
                ui.event_filter(bad)

    def test_every_listed_state_reads_as_a_filter(self):
        for member in mail_event_pb.MailEvent_State:
            if member:
                assert ui.event_filter(f"state = {member.name}") == (wire_name(member), False)

    def test_task_id_only_with_task_created(self):
        created, dismiss = mail_event_pb.ReconcileAction.TASK_CREATED, mail_event_pb.ReconcileAction.DISMISS
        assert ui.reconcile_task_id(created, "6X7rM8997g3RQmvh") == "6X7rM8997g3RQmvh"
        assert ui.reconcile_task_id(dismiss, "") is None
        for bad in ("", "a" * 65, "has space"):
            with refused(Reason.BAD_REQUEST):
                ui.reconcile_task_id(created, bad)
        with refused(Reason.BAD_REQUEST):
            ui.reconcile_task_id(dismiss, "6X7rM8997g3RQmvh")

    def test_read_request_is_strict(self):
        from ziyixi_proto.todofy.ui.v1 import todofy_ui_service_pb as pb

        read = ui.read_request(pb.ListMailEventsRequest, '{"page_size": 3, "filter": "state = PENDING"}')
        assert read.page_size == 3 and read.filter == "state = PENDING"
        for text in ('{"limit": 3}', '{"state": "pending"}', '{"filter": 7}', "not json", "[]"):
            with refused(Reason.BAD_REQUEST):
                ui.read_request(pb.ListMailEventsRequest, text)


class TestCursors:
    def test_event_cursor_round_trip(self):
        assert ui.event_cursor(None) is None
        assert ui.event_cursor(ui.cursor_text({"at": 1700000000, "id": EVENT})) == (1700000000, EVENT)

    @pytest.mark.parametrize(
        "text", ["[]", "{}", '{"at": -1, "id": "x"}', f'{{"at": true, "id": "{EVENT}"}}', '{"at": 1, "id": "x"}', "{"]
    )
    def test_event_cursor_refuses_anything_else(self, text):
        with refused(Reason.BAD_REQUEST):
            ui.event_cursor(text)

    def test_text_cursors(self):
        assert ui.text_cursor('{"day": "2026-09-28"}', "day", ui.DAY) == "2026-09-28"
        assert ui.text_cursor('{"week": "2026-W39"}', "week", ui.WEEK) == "2026-W39"
        assert ui.text_cursor('{"week": "2026-W53"}', "week", ui.WEEK) == "2026-W53"  # 2026 has 53 ISO weeks
        with refused(Reason.BAD_REQUEST):
            ui.text_cursor('{"day": "2026-9-28"}', "day", ui.DAY)
        assert ui.cursor_text(None) is None

    @pytest.mark.parametrize(
        ("key", "value"),
        [
            ("day", "2026-02-30"),
            ("day", "2026-13-01"),
            ("day", "2026-00-10"),
            ("day", "0001-01-01"),
            ("day", "1969-12-31"),
            ("week", "2026-W99"),
            ("week", "2026-W00"),
            ("week", "2025-W53"),  # 2025 has 52
            ("week", "0001-W01"),
        ],
    )
    def test_a_cursor_must_name_a_real_day_or_week(self, key, value):
        pattern = ui.DAY if key == "day" else ui.WEEK
        with refused(Reason.BAD_REQUEST):
            ui.text_cursor(json.dumps({key: value}), key, pattern)


def summary_row(**overrides):
    return {
        "event_id": EVENT,
        "state": "todo_unknown",
        "error_code": "lookup_not_found",
        "attempt_count": 0,
        "task_id": None,
        "received_at": AT,
        "updated_at": "2026-09-28T08:02:10Z",
        "next_attempt_at": None,
        "attention": True,
        "imported": False,
    } | overrides


def detail_row(**overrides):
    return (
        summary_row()
        | {
            "version": 5,
            "crashes": 0,
            "subject": "Quarterly tax reminder",
            "from": "billing@example.com",
            "summary": "季度预缴税截止日期为 10 月 15 日。",
            "summary_model": "gemini-3.8-flash",
            "todo_body": "**FROM: billing@example.com**\n\nMail Hero event: " + EVENT,
            "todoist_request_id": "todofy-0123456789abcdef0123456789ab",
            "allowed_actions": ["task_created", "task_not_created", "dismiss"],
            "transitions": [
                {"at": AT, "from_state": None, "to_state": "pending", "error_code": None, "actor": "worker"},
                {
                    "at": AT,
                    "from_state": "summarized",
                    "to_state": "todo_unknown",
                    "error_code": "todo_result_unknown",
                    "actor": "worker",
                },
            ],
            "has_legacy_text": False,
        }
        | overrides
    )


BASIC_EVENT = {
    "name": f"mailEvents/{EVENT}",
    "state": "todo_unknown",
    "error_code": "lookup_not_found",
    "receive_time": AT,
    "update_time": "2026-09-28T08:02:10Z",
    "attention": True,
}


class TestMessages:
    def test_a_list_row_has_only_the_list_fields(self):
        assert json.loads(ui.answer(ui.mail_event(summary_row(), full=False))) == BASIC_EVENT

    def test_the_basic_view_of_a_detail_is_the_list_row(self):
        assert json.loads(ui.answer(ui.mail_event(detail_row(), full=False))) == BASIC_EVENT

    def test_views_follow_aip_157(self):
        view = mail_event_pb.MailEventView
        assert ui.full_view(view.UNSPECIFIED) and ui.full_view(view.FULL) and not ui.full_view(view.BASIC)
        ui.list_view(view.UNSPECIFIED)
        ui.list_view(view.BASIC)
        with refused(Reason.BAD_REQUEST):
            ui.list_view(view.FULL)

    def test_a_detail(self):
        wire = json.loads(ui.answer(ui.mail_event(detail_row())))
        assert wire["etag"] == "5" and wire["version"] == 5
        assert wire["sender"] == "billing@example.com"
        assert wire["allowed_actions"] == ["task_created", "task_not_created", "dismiss"]
        assert wire["transitions"][0] == {"transition_time": AT, "state": "pending", "actor": "worker"}
        assert wire["transitions"][1]["prior_state"] == "summarized"
        assert "legacy_text" not in wire and "canary" not in wire

    def test_a_detail_with_legacy_text_and_a_canary(self):
        wire = json.loads(ui.answer(ui.mail_event(detail_row(has_legacy_text=True, canary=True, allowed_actions=[]))))
        assert wire["legacy_text"] == f"legacyTexts/{EVENT}"
        assert wire["canary"] is True and "allowed_actions" not in wire

    def test_a_review_id_is_its_iso_week_in_lower_case(self):
        review = {"week": "2026-W40", "state": "created", "created_at": AT, "completed_at": None}
        assert json.loads(ui.answer(ui.gtd_review(review)))["name"] == "gtdReviews/2026-w40"

    def test_an_unknown_code_reads_as_unset(self):
        wire = json.loads(ui.answer(ui.mail_event(summary_row(error_code="something_new"), full=False)))
        assert "error_code" not in wire

    def test_service_status(self):
        overview = {
            "build": "abc",
            "now": AT,
            "flags": {
                "maintenance_mode": False,
                "processing_paused": True,
                "force_pause_todoist": False,
                "reminder_enabled": True,
            },
            "counts": {state: index for index, state in enumerate(ACTIVE_STATES)},
            "attention_count": 1,
            "received_24h": 42,
            "latest_reminder": {
                "day": "2026-09-28",
                "state": "created",
                "task_id": "123",
                "attention_count": 2,
                "attempts": 1,
                "error_code": None,
                "next_attempt_at": None,
                "created_at": AT,
                "updated_at": AT,
                "imported": False,
            },
            "next_alarm_at": AT,
            "oldest_due_at": None,
            "gemini": {
                "day": "2026-09-28",
                "token_budget": 2**40,
                "reserved_tokens": 4096,
                "used_tokens": 1,
                "calls": 3,
                "models": ["m1", "m2"],
            },
            "todoist": {"blocked_until": None, "window_seconds": 900, "window_calls": 3, "window_limit": 1000},
            "backup": {
                "status": "ok",
                "last_backup_at": AT,
                "last_backup_key": "backups/x/",
                "last_backup_bytes": 10,
                "last_backup_rows": 2,
                "last_failure_at": None,
                "last_error_code": None,
                "next_backup_at": AT,
            },
        }
        wire = json.loads(ui.answer(ui.service_status(overview)))
        assert wire["name"] == "serviceStatus" and wire["read_time"] == AT
        assert wire["switches"] == {"processing_paused": True, "reminder_enabled": True}
        assert wire["active_counts"]["failed_summary_count"] == 6
        assert wire["latest_reminder"]["name"] == "dailyReminders/2026-09-28"
        # A budget beyond int32 is written as the bound instead of failing the page.
        assert wire["gemini"]["token_budget"] == 2**31 - 1
        assert wire["backup"]["state"] == "ok" and "next_alarm_time" in wire

    def test_metric_and_gtd_days(self):
        day = {
            "day": "2026-09-27",
            "recorded": True,
            "mails_received": 64,
            "mails_completed": 61,
            "mails_failed": 1,
            "latency_p50_seconds": 18,
            "latency_p90_seconds": None,
            "gemini_calls": 66,
            "gemini_tokens": {"m1": 402113},
            "todoist_creates": 62,
            "todoist_lookups": 0,
        }
        wire = json.loads(ui.answer(ui.metric_day(day)))
        assert wire["name"] == "metricDays/2026-09-27" and wire["latency_p50_seconds"] == 18
        assert "latency_p90_seconds" not in wire and wire["gemini_tokens"] == {"m1": 402113}
        scope = {
            "open": 9,
            "age_0_7": 1,
            "age_8_14": 2,
            "age_15_30": 3,
            "age_31_plus": 3,
            "oldest_days": 40,
            "overdue": 0,
            "undated": 5,
            "created_7d": None,
            "completed_7d": 0,
            "completed_source": "api",
            "closed_1d": 2,
            "mail_open": None,
            "complete": True,
        }
        gtd = json.loads(ui.answer(ui.gtd_day({"day": "2026-09-28", "recorded": True, "all": scope, "inbox": None})))
        assert gtd["all_projects"]["old_count"] == 3 and gtd["all_projects"]["completed_last_week_count"] == 0
        assert "created_last_week_count" not in gtd["all_projects"] and "inbox" not in gtd

    def test_reports_read_leniently(self):
        report = {
            "summary": "x",
            "task_count": 1,
            "time_window_hours": 24,
            "status": "ok",
            "model": "m",
            "computed_at": AT,
            "window_start": AT,
            "window_end": AT,
            "added_later": 1,
        }
        message = ui.summary_report(report)
        assert message is not None
        assert ui.summary_report({"summary": 1}) is None
        latest = reports_pb.LatestReports(name="latestReports", summary=message)
        assert json.loads(ui.answer(latest))["summary"]["status"] == "ok"

    def test_report_kind(self):
        assert ui.report_kind(reports_pb.ReportKind.SUMMARY) == "summary"
        with refused(Reason.BAD_REQUEST):
            ui.report_kind(reports_pb.ReportKind.UNSPECIFIED)

    def test_every_message_reads_back_strictly(self):
        message = ui.mail_event(detail_row())
        assert from_wire(mail_event_pb.MailEvent, json.loads(ui.answer(message)), strict=True).message == message
