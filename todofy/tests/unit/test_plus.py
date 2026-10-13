"""Personal planning behavior, using synthetic tasks only."""

import sqlite3
from pathlib import Path

import pytest

from todofy.core import plus
from todofy.core.sql import plus as sql

TODAY = "2026-10-13"
REQUEST = "f4438dda-dc8d-4732-aa59-bdb1a4dc21fa"


def task(**values):
    return {
        "id": "task1",
        "content": "Synthetic report",
        "labels": ["office", "deep"],
        "project_id": "project1",
        **values,
    }


def test_stage_change_retains_unrelated_labels_and_bet_does_not_promote():
    source = task(labels=["committed", "focus", "office", "deep", "lead_2w", "bets"])
    assert plus.plan_labels(source, {"stage": "monthly"}) == ["bets", "candiate", "deep", "lead_2w", "office"]
    assert plus.plan_labels(task(), {"bet": True}) == ["bets", "deep", "office"]
    assert plus.plan_labels(source, {"area": "personal"}) == ["bets", "committed", "deep", "focus", "home", "lead_2w"]


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
    assert not plus.task_view(task(deadline={"date": TODAY}, labels=["lead_2w", "waiting"]), TODAY)["must_start"]
    assert plus.task_view(task(deadline={"date": "2026-10-12"}, labels=["waiting"]), TODAY)["must_start"]
    assert plus.task_view(task(deadline={"date": TODAY}), TODAY)["missing_lead"]
    assert plus.lead_args(task(labels=["lead_1m", "deep"]), TODAY, 7) == {
        "labels": ["deep", "lead_1w"],
        "deadline": {"date": TODAY},
    }


def test_estimates_are_optional_and_two_hours_is_not_rejected():
    assert "estimated_minutes" not in plus.task_view(task(), TODAY)
    assert plus.task_view(task(duration={"amount": 180, "unit": "minute"}), TODAY)["estimated_minutes"] == 180
    assert plus.task_view(task(duration={"amount": 1, "unit": "day"}), TODAY)["estimated_minutes"] == 480


def test_mapping_never_fuzzy_matches_or_adopts_duplicate_labels():
    labels = [{"id": f"id-{role}", "name": role} for role in plus.ROLES]
    assert not plus.discover(labels, "UTC")["missing_labels"]
    assert plus.discover([*labels, {"id": "other", "name": "home"}], "UTC")["missing_labels"] == ["home"]
    assert plus.discover(labels, "UTC")["etag"] != plus.discover(labels, "America/Los_Angeles")["etag"]


def test_reset_clears_only_ended_week_marks_and_moves_only_commitments():
    assert plus.reset_labels(task(labels=["bets", "committed", "office", "lead_1w"]), {"committed": 1, "bet": 1}) == [
        "focus",
        "lead_1w",
        "office",
    ]
    assert plus.reset_labels(task(labels=["bets", "candiate"]), {"committed": 0, "bet": 1}) == ["candiate"]
    assert plus.week_start("2026-10-18") == "2026-10-12"
    assert plus.week_start("2026-10-19") == "2026-10-19"
    db = sqlite3.connect(":memory:")
    migration = Path(__file__).resolve().parents[2] / "migrations/0006_todoist_plus.sql"
    db.executescript(migration.read_text())
    db.execute(sql.REMEMBER_WEEK, ("task1", "2026-10-12", 1, 1))
    db.execute(sql.REMEMBER_WEEK, ("task1", "2026-10-19", 1, 1))
    assert db.execute(sql.ENDED_WEEK, ("2026-10-19",)).fetchall() == []


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
    assert len(plus.replaced_filters(filters)) == len(plus.REPLACED_FILTER_QUERIES)
    assert (
        plus.replaced_filters(
            [
                {"id": "waiting", "query": "@blocked"},
                {"id": "unfamiliar", "query": "@bets | @custom"},
            ]
        )
        == []
    )
