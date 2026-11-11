"""Candidates: sampling, point-in-time membership, default securities, live decisions."""

from __future__ import annotations

import unittest
from datetime import date
from typing import Any

import pandas as pd

import research_datasets
from research_datasets import candidates
from tests.test_labels import BENCH, LabelVersion, asset, benchmark_rows, session_rows

A, B, C = asset(1), asset(2), asset(3)
# 2026-01-26 (Mon) .. 2026-03-02 (Mon): January ends on Friday 01-30.
DAYS = pd.bdate_range("2026-01-26", "2026-03-02").date.tolist()


def member(
    asset_id: str,
    month: str,
    flag: bool,
    *,
    sequence: int = 1,
    warmup: bool = False,
    rule: str = "pit-largecap-v1",
) -> dict[str, Any]:
    return {
        "rule_version": rule,
        "effective_month": month,
        "asset_id": asset_id,
        "member": flag,
        "warmup": warmup,
        "observation_sequence": sequence,
    }


def membership_version(**options: Any) -> LabelVersion:
    rows = [
        member(A, "2026-01", True),
        member(B, "2026-01", True, warmup=True, sequence=0),  # superseded warm-up
        member(B, "2026-01", False),
        member(C, "2026-01", False),
        member(C, "2026-01", True, warmup=True, sequence=2),  # latest is a warm-up
        member(A, "2026-02", True),
        member(A, "2026-02", False, sequence=2),  # the latest observation wins
        member(B, "2026-02", True),
        member(A, "2026-01", False, rule="pit-liquid-v1"),
    ]
    families = {
        "universe_membership": rows,
        "daily_returns": [
            *session_rows(A, [10.0 + i for i in range(len(DAYS))], days=DAYS),
            *session_rows(B, [20.0 + i for i in range(len(DAYS))], days=DAYS),
            *benchmark_rows(DAYS),
        ],
    }
    return LabelVersion([A, B, C, BENCH], days=DAYS, families=families, **options)


def rows(frame: pd.DataFrame, asset_id: str) -> pd.DataFrame:
    return frame[frame["asset_id"] == asset_id].set_index("signal_session")


class MembershipTest(unittest.TestCase):
    def test_monthly_membership_uses_entry_session_month(self) -> None:
        version = membership_version()
        frame = research_datasets.build_candidates(
            version, [A, B, C], keep_non_members=True
        )
        thursday, friday = date(2026, 1, 29), date(2026, 1, 30)
        # Signal Thursday enters Friday (January); signal Friday enters Monday (February).
        self.assertEqual(rows(frame, A).loc[thursday, "entry_session"], friday)
        january = [rows(frame, item).loc[thursday, "in_universe"] for item in (A, B, C)]
        self.assertEqual(january[:2], [True, False])
        self.assertTrue(pd.isna(january[2]))  # unknown: the latest row is a warm-up
        self.assertEqual(
            [rows(frame, item).loc[friday, "in_universe"] for item in (A, B, C)],
            [False, True, False],
        )
        # Entry in March: outside the rule's known months; last session: no entry.
        self.assertTrue(pd.isna(rows(frame, A).loc[date(2026, 2, 27), "in_universe"]))
        self.assertTrue(pd.isna(rows(frame, A).loc[DAYS[-1], "in_universe"]))
        kept = research_datasets.build_candidates(version, [A, B, C])
        self.assertEqual(
            set(rows(kept, A).index), {day for day in DAYS if day < friday}
        )
        self.assertEqual(kept.attrs["parameters"]["universe_basis"], "pit")
        self.assertEqual(
            kept.attrs["counts"]["not_in_universe_dropped"], len(frame) - len(kept)
        )
        # The manifest's known months turn March into a known month without a row.
        extended = membership_version(
            manifest={"universe_rule": {"last_effective_month": "2026-03"}}
        )
        frame = research_datasets.build_candidates(extended, [A], keep_non_members=True)
        self.assertFalse(rows(frame, A).loc[date(2026, 2, 27), "in_universe"])
        liquid = research_datasets.build_candidates(
            version, [A], universe="pit-liquid-v1", keep_non_members=True
        )
        self.assertFalse(rows(liquid, A).loc[thursday, "in_universe"])
        # Labels judge candidates under the rule they were built with.
        with self.assertRaisesRegex(ValueError, "pit-liquid-v1"):
            research_datasets.forward_returns(
                version, liquid, benchmark=BENCH, horizons=1
            )
        matched = research_datasets.forward_returns(
            version, liquid, benchmark=BENCH, horizons=1, universe="pit-liquid-v1"
        )
        self.assertFalse(rows(matched, A).loc[thursday, "in_universe"])
        self.assertFalse(rows(matched, A).loc[thursday, "trainable_1d"])
        static_rows = research_datasets.build_candidates(
            version, [A], universe="static"
        )
        with self.assertRaisesRegex(ValueError, "static"):
            research_datasets.forward_returns(
                version, static_rows, benchmark=BENCH, horizons=1
            )
        # A rule version without rows must be one the version exports.
        with self.assertRaisesRegex(ValueError, "pit-typo-v1"):
            research_datasets.build_candidates(version, [A], universe="pit-typo-v1")
        exported = membership_version(
            manifest={"universe_rule": {"export_rules": ["pit-other-v1"]}}
        )
        other = research_datasets.build_candidates(
            exported, [A], universe="pit-other-v1", keep_non_members=True
        )
        self.assertTrue(other["in_universe"].isna().all())
        # Labels: membership gates trainable; a static universe needs the opt-in.
        labels = research_datasets.forward_returns(
            version, frame, benchmark=BENCH, horizons=1
        )
        self.assertEqual(
            labels.loc[labels["signal_session"] == thursday, "trainable_1d"].tolist(),
            [True],
        )
        self.assertEqual(
            labels.loc[labels["signal_session"] == friday, "trainable_1d"].tolist(),
            [False],
        )
        # Only A's four January-entry signals are members.
        self.assertEqual(labels.attrs["masks"]["1"]["not_in_universe"], len(DAYS) - 4)
        static = LabelVersion([A, BENCH], days=DAYS, families={"daily_returns": []})
        with self.assertRaisesRegex(ValueError, "UNIVERSE_NOT_PIT"):
            research_datasets.forward_returns(static, [A], benchmark=BENCH)

    def test_default_candidates_exclude_benchmark_and_non_common(self) -> None:
        universe = [
            {"asset_id": A, "symbol": "AAA", "security_type": "common"},
            {"asset_id": B, "symbol": "BBB", "security_type": "etf"},
            {"asset_id": C, "symbol": "CCC"},
            {"asset_id": asset(4), "symbol": "DDD", "security_type": "common_presumed"},
            {"asset_id": asset(5), "symbol": "IDX", "is_benchmark": True},
            {"asset_id": BENCH, "symbol": "SPY", "security_type": "etf"},
            {"asset_id": asset(6), "symbol": "QQQ", "security_type": "common"},
        ]
        version = LabelVersion([], days=DAYS, universe=universe)
        frame = research_datasets.build_candidates(version, benchmark="QQQ")
        self.assertEqual(list(dict.fromkeys(frame["asset_id"])), [A, C, asset(4)])
        self.assertTrue(frame["in_universe"].isna().all())
        self.assertEqual(frame.attrs["parameters"]["universe_basis"], "static")
        # An explicit selection keeps what was asked for, flagged.
        chosen = research_datasets.build_candidates(version, ["IDX", "BBB"])
        self.assertEqual(
            chosen.groupby("asset_id", sort=False)["is_benchmark"].first().tolist(),
            [True, False],
        )


class SamplingTest(unittest.TestCase):
    def test_weekly_monthly_sampling_completed_periods_only(self) -> None:
        # Friday 2026-04-03 is a holiday; the calendar ends Wednesday 2026-04-29.
        days = [
            day
            for day in pd.bdate_range("2026-03-23", "2026-04-29").date
            if day != date(2026, 4, 3)
        ]
        weekly = [days[p] for p in candidates.sample_positions(days, "weekly")]
        self.assertEqual(weekly[:2], [date(2026, 3, 27), date(2026, 4, 2)])
        self.assertEqual(weekly[-1], date(2026, 4, 24))  # the last week is partial

        def last(frozen: list[date], following: date | None) -> date:
            return frozen[candidates.sample_positions(frozen, "weekly", following)[-1]]

        # A next session in the same week does not complete it; one a week later does.
        self.assertEqual(last(days, date(2026, 4, 30)), date(2026, 4, 24))
        self.assertEqual(last(days, date(2026, 5, 4)), date(2026, 4, 29))
        self.assertEqual(last(days[:-3], None), date(2026, 4, 17))
        self.assertEqual(last(days[:-3], date(2026, 4, 27)), date(2026, 4, 24))
        monthly = [days[p] for p in candidates.sample_positions(days, "monthly")]
        self.assertEqual(monthly, [date(2026, 3, 31)])
        completed = candidates.sample_positions(days, "monthly", date(2026, 5, 1))
        self.assertEqual(
            [days[p] for p in completed], [date(2026, 3, 31), date(2026, 4, 29)]
        )
        self.assertEqual(len(candidates.sample_positions(days, "daily")), len(days))
        with self.assertRaisesRegex(ValueError, "sampling"):
            candidates.sample_positions(days, "hourly")
        # Labels record their overlap with the sampling step.
        version = LabelVersion(
            [A, BENCH],
            days=days,
            families={
                "daily_returns": session_rows(
                    A, [10.0 + i for i in range(len(days))], days=days
                )
                + benchmark_rows(days)
            },
        )
        labels = research_datasets.forward_returns(
            version,
            [A],
            benchmark=BENCH,
            horizons=(5, 10),
            sampling="weekly",
            allow_static_universe=True,
        )
        self.assertEqual(
            [str(day) for day in labels["signal_session"]],
            [str(day) for day in weekly],
        )
        self.assertEqual(labels.attrs["label_overlap"], {"5": 1.0, "10": 2.0})


class ClockTest(unittest.TestCase):
    def test_next_session_gives_live_decision_for_last_signal(self) -> None:
        version = LabelVersion([A, BENCH], days=DAYS[:5])
        frame = research_datasets.build_candidates(version, [A])
        self.assertTrue(pd.isna(frame.iloc[-1]["decision_at"]))
        self.assertIsNone(frame.iloc[-1]["entry_session"])
        live = research_datasets.build_candidates(
            version, [A], next_session="2026-02-02"
        )
        last = live.iloc[-1]
        self.assertEqual(last["decision_at"], pd.Timestamp("2026-02-02T11:00:00Z"))
        self.assertEqual(
            last["capture_deadline_at"], pd.Timestamp("2026-02-02T14:00:00Z")
        )
        self.assertEqual(last["label_start"], pd.Timestamp("2026-02-02T14:30:00Z"))
        self.assertEqual(last["entry_session"], date(2026, 2, 2))
        self.assertEqual(
            live.iloc[0]["previous_decision_at"], pd.Timestamp("2026-01-26T11:00:00Z")
        )
        with self.assertRaisesRegex(ValueError, "next_session"):
            research_datasets.build_candidates(version, [A], next_session="2026-01-31")

    def test_live_row_at_month_end_carries_last_known_membership(self) -> None:
        # Frozen through Friday 01-30 with January membership only; the next session
        # is in February, whose membership is ranked on its first session.
        january = [member(A, "2026-01", True), member(B, "2026-01", False)]
        version = LabelVersion(
            [A, B, BENCH], days=DAYS[:5], families={"universe_membership": january}
        )
        live = research_datasets.build_candidates(
            version, [A, B], next_session="2026-02-02", keep_non_members=True
        )
        last = live[live["signal_session"] == DAYS[4]].set_index("asset_id")
        self.assertEqual(last["in_universe"].tolist(), [True, False])
        self.assertEqual(last["membership_carried"].tolist(), [True, True])
        self.assertFalse(
            live.loc[live["signal_session"] < DAYS[4], "membership_carried"].any()
        )
        kept = research_datasets.build_candidates(
            version, [A, B], start=DAYS[4], end=DAYS[4], next_session="2026-02-02"
        )
        self.assertEqual(kept["asset_id"].tolist(), [A])
        self.assertEqual(kept.attrs["counts"]["membership_carried"], 1)
        self.assertEqual(kept.attrs["parameters"]["membership_carried_from"], "2026-01")
        self.assertFalse(kept.attrs["parameters"]["live_membership_unknown"])
        # Only the month right after the last known one is carried: a March live
        # session with January membership is unknown (NA, dropped under pit).
        stale = research_datasets.build_candidates(
            version, [A, B], next_session="2026-03-02", keep_non_members=True
        )
        self.assertTrue(
            stale.loc[stale["signal_session"] == DAYS[4], "in_universe"].isna().all()
        )
        self.assertFalse(stale["membership_carried"].any())
        self.assertIsNone(stale.attrs["parameters"]["membership_carried_from"])
        self.assertTrue(stale.attrs["parameters"]["live_membership_unknown"])
        self.assertTrue(
            research_datasets.build_candidates(
                version, [A], start=DAYS[4], next_session="2026-03-02"
            ).empty
        )
        self.assertEqual(candidates.following_month("2026-12"), "2027-01")
        # Without a live session nothing is carried: the last signal has no entry.
        frozen = research_datasets.build_candidates(version, [A], keep_non_members=True)
        self.assertTrue(pd.isna(frozen.iloc[-1]["in_universe"]))
        self.assertFalse(frozen["membership_carried"].any())
        # A known February (manifest) without a row for A is not carried: A is out.
        ranked = LabelVersion(
            [A, B, BENCH],
            days=DAYS[:5],
            families={"universe_membership": january},
            manifest={"universe_rule": {"last_effective_month": "2026-02"}},
        )
        live = research_datasets.build_candidates(
            ranked, [A], next_session="2026-02-02", keep_non_members=True
        )
        self.assertFalse(live.iloc[-1]["in_universe"])
        self.assertFalse(live["membership_carried"].any())

    def test_half_day_label_end_uses_frozen_close_and_defaults_to_1600(self) -> None:
        closes = [10.0 + i for i in range(len(DAYS))]
        families = {
            "daily_returns": session_rows(A, closes, days=DAYS) + benchmark_rows(DAYS)
        }
        for manifest, expected in (
            ({}, "2026-01-30T21:00:00Z"),
            ({"calendar_closes": {"2026-01-30": "13:00"}}, "2026-01-30T18:00:00Z"),
        ):
            with self.subTest(closes=manifest):
                version = LabelVersion(
                    [A, BENCH], days=DAYS, families=families, manifest=manifest
                )
                labels = research_datasets.forward_returns(
                    version,
                    pd.DataFrame({"asset_id": [A], "signal_session": [DAYS[2]]}),
                    benchmark=BENCH,
                    horizons=2,  # entry Thursday 01-29, exit Friday 01-30
                    allow_static_universe=True,
                )
                self.assertEqual(labels.iloc[0]["label_end"], pd.Timestamp(expected))
                self.assertEqual(
                    labels.iloc[0]["label_start"], pd.Timestamp("2026-01-29T14:30:00Z")
                )


if __name__ == "__main__":
    unittest.main()
