"""Personal planning behavior, using synthetic tasks only."""

import sqlite3
from pathlib import Path

import pytest

from todofy.core import plus
from todofy.core.sql import native_plan as native_sql
from todofy.core.sql import plus as sql

TODAY = "2026-10-13"
REQUEST = "f4438dda-dc8d-4732-aa59-bdb1a4dc21fa"


def migrated() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    for migration in sorted((Path(__file__).resolve().parents[2] / "migrations").glob("*.sql")):
        db.executescript(migration.read_text())
    return db


def task(**values):
    return {
        "id": "task1",
        "content": "Synthetic report",
        "labels": ["office", "deep"],
        "project_id": "project1",
        **values,
    }


def test_an_in_progress_task_need_not_start_and_misses_no_lead():
    view = plus.task_view(task(labels=["active", "lead_1w"], deadline={"date": TODAY}), TODAY)
    assert not view["must_start"] and not view["missing_lead"]


def test_in_progress_never_moves_a_kept_sunday_choice():
    week, sunday = "2026-10-12", "2026-10-18"
    assert plus.membership_week(sunday, week, {"active": True}) == week
    db = sqlite3.connect(":memory:")
    db.executescript((Path(__file__).resolve().parents[2] / "migrations/0006_todoist_plus.sql").read_text())
    db.execute(sql.REMEMBER_WEEK, ("task1", "2026-10-19", 1, 0))
    # Marking it in progress that Sunday records its marks under the ending week, which never moves it back.
    db.execute(sql.REMEMBER_WEEK, ("task1", plus.membership_week(sunday, week, {"active": True}), 1, 0))
    assert db.execute("SELECT week_start FROM plus_weeks WHERE task_id='task1'").fetchone() == ("2026-10-19",)


def test_a_quick_tasks_focus_or_candiate_gives_no_stage():
    for planning in ("focus", "candiate"):
        assert plus.label_stage({"quick", planning}, plus.role_labels()) == "none"


def test_display_preserves_candidate_date_rule_and_deduplicates_commitments():
    assert plus.task_view(task(labels=["focus", "committed"]), TODAY)["stage"] == "committed"
    assert plus.task_view(task(due={"date": "2026-10-12"}), TODAY)["stage"] == "weekly"
    assert plus.task_view(task(deadline={"date": TODAY}), TODAY)["stage"] == "weekly"
    assert plus.task_view(task(due={"date": "2027-01-01"}, deadline={"date": TODAY}), TODAY)["stage"] == "none"
    assert plus.task_view(task(labels=["routine"], due={"date": TODAY}), TODAY)["stage"] == "none"
    assert plus.task_view(task(labels=["candiate"]), TODAY)["stage"] == "monthly"
    assert plus.task_view(task(labels=["office", "home"]), TODAY)["area"] == "unassigned"


def test_deadline_is_not_scheduled_date_and_preserves_filter_boundaries():
    assert not plus.task_view(task(due={"date": TODAY}, labels=["lead_2w"]), TODAY)["must_start"]
    assert plus.task_view(task(deadline={"date": "2026-10-26"}, labels=["lead_2w"]), TODAY)["must_start"]
    assert not plus.task_view(task(deadline={"date": "2026-10-27"}, labels=["lead_2w"]), TODAY)["must_start"]
    # The same edge for lead_3d: two days ahead it must start, three days ahead not yet.
    assert plus.task_view(task(deadline={"date": "2026-10-15"}, labels=["lead_3d"]), TODAY)["must_start"]
    assert not plus.task_view(task(deadline={"date": "2026-10-16"}, labels=["lead_3d"]), TODAY)["must_start"]
    assert not plus.task_view(task(deadline={"date": TODAY}, labels=["lead_2w", "waiting"]), TODAY)["must_start"]
    assert plus.task_view(task(deadline={"date": "2026-10-12"}, labels=["waiting"]), TODAY)["must_start"]
    assert plus.task_view(task(deadline={"date": TODAY}), TODAY)["missing_lead"]


def test_the_position_is_answered_within_bounds_and_left_out_of_the_etag():
    for value in (-(2**31), 0, 2**31 - 1):
        assert plus.task_view(task(child_order=value), TODAY)["child_order"] == value
    for value in (None, True, 2**31, -(2**31) - 1, "3", 1.5):
        assert "child_order" not in plus.task_view(task(child_order=value), TODAY)
    assert plus.task_etag(task(child_order=1)) == plus.task_etag(task(child_order=2))


def test_estimates_are_optional_and_two_hours_is_not_rejected():
    assert "estimated_minutes" not in plus.task_view(task(), TODAY)
    assert plus.task_view(task(duration={"amount": 180, "unit": "minute"}), TODAY)["estimated_minutes"] == 180


def test_the_week_starts_on_monday_and_a_row_kept_for_it_has_not_ended():
    assert plus.week_start("2026-10-18") == "2026-10-12"
    assert plus.week_start("2026-10-19") == "2026-10-19"
    db = migrated()
    db.execute(sql.REMEMBER_WEEK, ("task1", "2026-10-12", 1, 1))
    db.execute(sql.REMEMBER_WEEK, ("task1", "2026-10-19", 1, 1))
    assert db.execute(native_sql.ENDED_WEEK.sql, ("2026-10-19",)).fetchall() == []


def test_only_a_commitment_chosen_on_the_last_day_waits_for_the_next_week():
    week, sunday = "2026-10-12", "2026-10-18"
    assert plus.membership_week(sunday, week, {"stage": "committed", "task_id": "task1"}) == "2026-10-19"
    # Other stages, an area or a deadline change on Sunday stay in the ending week.
    for request in ({"stage": "weekly"}, {"area": "work"}, {"deadline": sunday, "lead_days": 7}):
        assert plus.membership_week(sunday, week, request) == week
    # In progress as well, it is still a commitment for the next week.
    assert plus.membership_week(sunday, week, {"stage": "committed", "active": True}) == "2026-10-19"
    # A commitment made on any other day of the week ends with it.
    for today in ("2026-10-12", "2026-10-14", "2026-10-17"):
        assert plus.membership_week(today, week, {"stage": "committed"}) == week


def test_membership_never_moves_back_so_sunday_scans_cannot_undo_a_next_week_choice():
    db = migrated()

    def week_of(task_id):
        return db.execute("SELECT week_start, committed, bet FROM plus_weeks WHERE task_id=?", (task_id,)).fetchone()

    db.execute(sql.REMEMBER_WEEK, ("sunday", "2026-10-19", 1, 0))
    db.execute(sql.REMEMBER_WEEK, ("weekday", "2026-10-12", 1, 1))
    # The ten-minute scan on Sunday remembers both under the ending week.
    db.execute(sql.REMEMBER_WEEK, ("sunday", "2026-10-12", 1, 1))
    db.execute(sql.REMEMBER_WEEK, ("weekday", "2026-10-12", 1, 0))
    # The week stays; the marks follow what the scan saw (a Bet added since in native Todoist).
    assert week_of("sunday") == ("2026-10-19", 1, 1)
    assert week_of("weekday") == ("2026-10-12", 1, 0)
    assert db.execute(sql.NEXT_WEEK, ("2026-10-12",)).fetchall() == [("sunday",)]
    # Monday's reset selects only the ending week's row, and the new week's scan may update the kept one.
    assert [row[0] for row in db.execute(native_sql.ENDED_WEEK.sql, ("2026-10-19",))] == ["weekday"]
    db.execute(sql.REMEMBER_WEEK, ("sunday", "2026-10-19", 1, 1))
    assert week_of("sunday") == ("2026-10-19", 1, 1)
    assert db.execute(sql.NEXT_WEEK, ("2026-10-19",)).fetchall() == []
    plan = " ".join(row[3] for row in db.execute("EXPLAIN QUERY PLAN " + sql.NEXT_WEEK, ("2026-10-12",)))
    assert "plus_weeks_ended" in plan and "TEMP B-TREE" not in plan


def test_a_sunday_removal_updates_a_kept_choice_and_one_leaving_no_mark_forgets_it():
    db = migrated()

    def week_of(task_id):
        return db.execute("SELECT week_start, committed, bet FROM plus_weeks WHERE task_id=?", (task_id,)).fetchone()

    # Kept on Sunday with both marks; removing the Bet keeps the commitment for next week.
    db.execute(sql.REMEMBER_WEEK, ("both", "2026-10-19", 1, 1))
    db.execute(sql.REMEMBER_WEEK, ("both", "2026-10-12", 1, 0))
    assert week_of("both") == ("2026-10-19", 1, 0)
    # A kept goal whose Bet is removed again is no longer a choice.
    db.execute(sql.REMEMBER_WEEK, ("goal", "2026-10-19", 0, 1))
    db.execute(sql.FORGET_TASK, ("goal",))
    assert week_of("goal") is None
    assert db.execute(sql.NEXT_WEEK, ("2026-10-12",)).fetchall() == [("both",)]
    # So a mark added again later that Sunday, here by a page scan, resets on Monday as usual.
    db.execute(sql.REMEMBER_WEEK, ("goal", "2026-10-12", 0, 1))
    assert week_of("goal") == ("2026-10-12", 0, 1)
    assert [row[0] for row in db.execute(native_sql.ENDED_WEEK.sql, ("2026-10-19",))] == ["goal"]
    # An unchanged scan writes nothing.
    changes = db.total_changes
    db.execute(sql.REMEMBER_WEEK, ("both", "2026-10-12", 1, 0))
    db.execute(sql.REMEMBER_WEEK, ("goal", "2026-10-12", 0, 1))
    assert db.total_changes == changes


def test_update_time_is_whole_seconds_utc_and_absent_when_unknown():
    assert plus.task_view(task(updated_at="2026-10-14T09:30:05.123456Z"), TODAY)["update_time"] == (
        "2026-10-14T09:30:05Z"
    )
    assert plus.task_view(task(updated_at="2026-10-14T11:30:05+02:00"), TODAY)["update_time"] == (
        "2026-10-14T09:30:05Z"
    )
    for value in (None, "", "yesterday", "2026-10-14T09:30:05"):
        assert "update_time" not in plus.task_view(task(updated_at=value), TODAY)


def test_command_identity_is_stable_and_temporary_dom_ids_are_rejected():
    assert plus.command_id(REQUEST, 0) == plus.command_id(REQUEST, 0)
    assert plus.command_id(REQUEST, 0) != plus.command_id(REQUEST, 1)
    with pytest.raises(ValueError):
        plus.check_id("tmp-local-task")


def test_only_replaced_filter_queries_are_hidden():
    filters = [
        {"id": "matched-" + str(index), "query": query.replace("&", " & ").replace("@", "%")}
        for index, query in enumerate(plus.REPLACED_FILTER_QUERIES)
    ]
    assert len(plus.replaced_filters(filters, label_names={"parked"})) == len(plus.REPLACED_FILTER_QUERIES)
    assert plus.replaced_filters(
        [
            {"id": "waiting", "query": "@blocked"},
            {"id": "unfamiliar", "query": "@bets | @custom"},
        ]
    ) == ["waiting"]
    # Quick tasks are Week's Quick source and parked ones Review's Parked lane, which exists only while the account
    # has a label named parked: without one (a shared label, say) the parked view stays native.
    quick = {"id": "quick", "query": "@quick & (no date | 3 days)"}
    parked = {"id": "parked", "query": "@parked"}
    assert plus.replaced_filters([quick, parked], label_names={"quick", "parked"}) == ["quick", "parked"]
    assert plus.replaced_filters([quick, parked], label_names={"quick", "Parked"}) == ["quick"]
    assert plus.replaced_filters([{"id": "quick-4", "query": "@quick & (no date | 4 days)"}]) == []


def mapping():
    """A setup confirmed before the Bets became text: it still binds the retired bets role."""
    roles = (*plus.ROLES, *plus.LEGACY_ROLES, "quarter")
    return [{"role": role, "id": "id-" + role, "label": "custom-" + role} for role in roles]


def test_the_retired_bets_binding_is_kept_and_its_filter_stays_hidden():
    current = mapping()
    assert {"role": "bets", "id": "id-bets", "label": "custom-bets"} in current
    # @bets was checked against the bets binding's name; with the role retired it is always replaced.
    bets = [{"id": "bets-filter", "query": "@bets"}]
    assert plus.replaced_filters(bets) == plus.replaced_filters(bets, current) == ["bets-filter"]
    assert plus.replaced_filters(bets, current[:2]) == ["bets-filter"]


def test_configured_names_drive_stages_areas_bets_and_leads():
    bindings = mapping()
    source = task(
        labels=["custom-quarter", "custom-office", "custom-bets", "custom-lead_1w", "deep"],
        due={"date": TODAY},
        deadline={"date": TODAY},
    )
    view = plus.task_view(source, TODAY, bindings)
    assert view["stage"] == "quarterly" and view["area"] == "work" and view["bet"]
    assert view["lead_days"] == 7 and view["must_start"]
    assert source["due"] == {"date": TODAY}
    assert source["labels"] == ["custom-quarter", "custom-office", "custom-bets", "custom-lead_1w", "deep"]


def test_bets_do_not_enter_the_date_candidate_fallback_without_an_explicit_stage():
    assert plus.task_view(task(labels=["bets"], due={"date": TODAY}), TODAY)["stage"] == "none"
    assert plus.task_view(task(labels=["bets", "committed"], due={"date": TODAY}), TODAY)["stage"] == "committed"
    assert plus.task_view(task(labels=["custom-bets"], deadline={"date": TODAY}), TODAY, mapping())["stage"] == "none"
    assert plus.task_etag(task(), mapping()) != plus.task_etag(task(), mapping()[:-1])
