"""prepare() end to end: the private recipe's semantic cases, moved and adapted to 2.0.

Decisions are 06:00 New York on the entry session and inclusive; observed_content
captures count from their clock minus CAPTURE_GRACE (09:00 New York capture deadline).
In March 2026 the signal 03-06 decides at 2026-03-09T10:00Z (daylight time from 03-08).
"""

from __future__ import annotations

import json
import tempfile
import unittest
from copy import deepcopy
from datetime import date
from pathlib import Path
from typing import Any

import pandas as pd
from pandas.testing import assert_frame_equal

import research_datasets
from tests.test_events import (
    ASSET,
    BENCHMARK,
    DATASET,
    EARLY,
    OTHER,
    check,
    event,
    fixture,
    row,
)

OBSERVED = "observed_content"


def options(material: dict[str, Any], **changes: Any) -> dict[str, Any]:
    calendar = material["calendar"]
    values = {
        "dataset_id": DATASET,
        "asset_ids": [ASSET],
        "start": calendar[20],
        "end": calendar[35],
        "benchmark_id": BENCHMARK,
        "time_policy": OBSERVED,
        "train_end": calendar[23],
        "validation_end": calendar[29],
        "horizon": 5,
        "allow_static_universe": True,
    }
    values.update(changes)
    return values


def prepare(material: dict[str, Any], events=None, **changes: Any):
    if events is not None:
        material = {**material, "event_observations": pd.DataFrame(events)}
    return research_datasets.prepare(material, **options(material, **changes))


def features(material: dict[str, Any], events=None, **changes: Any) -> pd.DataFrame:
    return prepare(material, events, **changes)[0]


class PriceAndOutputTest(unittest.TestCase):
    def test_future_price_mutation_preserves_past_features_and_all_candidates(self):
        material = fixture()
        full = prepare(material)
        truncated = deepcopy(material)
        cutoff = date(2026, 3, 6)
        for family in ("raw", "all"):
            truncated[family] = truncated[family][truncated[family]["date"] <= cutoff]
        shorter = prepare(truncated)
        assert_frame_equal(
            full[0][["asset_id", "signal_session"]],
            shorter[0][["asset_id", "signal_session"]],
        )
        past = full[0]["signal_session"] <= cutoff
        assert_frame_equal(full[0][past], shorter[0][past])
        self.assertLess(
            shorter[3]["counts"]["pair_valid"], full[3]["counts"]["pair_valid"]
        )

    def test_twenty_returns_need_twenty_one_consecutive_closes(self):
        material = fixture()
        first = features(material).iloc[0]
        self.assertAlmostEqual(first.momentum20, 121 / 101 - 1)
        self.assertAlmostEqual(first.raw_dollar_volume, 121 * 30)
        self.assertFalse(first.price_history_missing)
        broken = deepcopy(material)
        gap = date.fromisoformat(broken["calendar"][10])
        adjusted = broken["all"]
        broken["all"] = adjusted[
            ~((adjusted["asset_id"] == ASSET) & (adjusted["date"] == gap))
        ]
        first = features(broken).iloc[0]
        self.assertTrue(first.price_history_missing)
        self.assertTrue(pd.isna(first.momentum20))
        self.assertTrue(pd.isna(first.volatility20))

    def test_purge_boundaries_ignore_label_values(self):
        material = fixture()
        both = {"asset_ids": [ASSET, OTHER]}
        frame, labels, splits, _ = prepare(material, **both)
        self.assertTrue(
            (splits.groupby("signal_session")["split"].nunique() == 1).all()
        )
        for previous, following in (("train", "validation"), ("validation", "test")):
            boundary = splits.loc[splits["split"] == following, "decision_at"].min()
            kept = splits[(splits["split"] == previous) & ~splits["purged"]]
            self.assertTrue((kept["label_end"] < boundary).all())
            self.assertTrue(splits.loc[splits["split"] == previous, "purged"].any())
        changed = deepcopy(material)
        later = changed["all"]["date"] > date.fromisoformat(material["calendar"][29])
        changed["all"].loc[later, "open"] = float("nan")
        assert_frame_equal(splits, prepare(changed, **both)[2])
        assert_frame_equal(
            frame[["asset_id", "signal_session"]],
            labels[["asset_id", "signal_session"]],
        )

    def test_split_free_preparation_keeps_every_candidate(self):
        material = fixture()
        frame, labels, splits, record = prepare(
            material, train_end=None, validation_end=None
        )
        self.assertIsNone(splits)
        assert_frame_equal(
            frame[["asset_id", "signal_session"]],
            labels[["asset_id", "signal_session"]],
        )
        self.assertEqual(record["counts"]["candidates"], len(frame))

    def test_parquet_outputs_and_honest_provenance(self):
        material = fixture()
        with tempfile.TemporaryDirectory() as directory:
            frame, labels, splits, record = prepare(material, output_dir=directory)
            for name, expected in (
                ("features", frame),
                ("labels", labels),
                ("split_membership", splits),
            ):
                actual = pd.read_parquet(Path(directory) / f"{name}.parquet")
                assert_frame_equal(expected, actual)
            self.assertEqual(
                json.loads((Path(directory) / "run.json").read_text()), record
            )
        self.assertEqual(record["manifest_sha256"], material["manifest_sha256"])
        self.assertEqual(record["code_sha256"], research_datasets.code_digest())
        self.assertEqual(record["package_version"], research_datasets.__version__)
        self.assertEqual(record["counts"]["candidates"], len(frame))
        self.assertIn("pandas", record["environment"])
        material.pop("manifest_sha256")
        with self.assertRaises(KeyError):
            prepare(material)


class ObservedClockTest(unittest.TestCase):
    def test_late_association_is_not_retroactive_or_repeated(self):
        # OTHER's association is captured at 13:01Z on 03-09, one minute after that
        # morning's 09:00 New York capture deadline: it counts from the next decision.
        associations = {ASSET: "2026-03-06T20:00:00Z", OTHER: "2026-03-09T13:01:00Z"}
        rows = [
            event("linked", asset_ids=[ASSET, OTHER], asset_first_seen_at=associations),
            event(
                "linked",
                observation_sequence=2,
                asset_ids=[ASSET, OTHER],
                content_first_seen_at="2026-03-10T12:00:00Z",
                observation_recorded_at="2026-03-10T12:00:00Z",
                asset_first_seen_at=list(associations.items()),
            ),
        ]
        frame = features(fixture(), rows, asset_ids=[ASSET, OTHER])
        self.assertEqual(row(frame).sec_events_1d, 1)
        self.assertEqual(row(frame, asset=OTHER).sec_events_1d, 0)
        self.assertEqual(row(frame, "2026-03-09", OTHER).sec_events_1d, 1)
        self.assertEqual(row(frame, "2026-03-09").sec_events_1d, 0)
        # At the deadline itself the association is visible to that morning's decision.
        associations[OTHER] = "2026-03-09T13:00:00Z"
        rows[0]["asset_first_seen_at"] = dict(associations)
        rows[1]["asset_first_seen_at"] = list(associations.items())
        frame = features(fixture(), rows, asset_ids=[ASSET, OTHER])
        self.assertEqual(row(frame, asset=OTHER).sec_events_1d, 1)
        self.assertEqual(row(frame, "2026-03-09", OTHER).sec_events_1d, 0)

    def test_missing_association_and_invalid_declared_public_clocks_do_not_fallback(
        self,
    ):
        for changes in (
            {"asset_first_seen_at": {}},
            {"observation_recorded_at": ""},
            {"public_at": "2026-03-06T20:00:00"},
            {"public_time_precision": "date", "public_date": ""},
        ):
            with self.subTest(changes=changes):
                frame = features(fixture(), [{**event(), **changes}])
                self.assertTrue(row(frame).sec_clock_missing)
                self.assertTrue(pd.isna(row(frame).sec_events_1d))

    def test_future_observations_cannot_resolve_historical_unknown_clock(self):
        rows = [
            event("known"),
            event("unresolved", asset_first_seen_at={}),
            event(
                "unresolved",
                observation_sequence=2,
                observation_recorded_at="2026-03-10T12:00:00Z",
            ),
            event(
                "seed",
                public_at="2000-01-01T00:00:00Z",
                filing_date="2026-03-10",
                event_date="2026-03-10",
                content_first_seen_at="2026-03-10T12:00:00Z",
                observation_recorded_at="2026-03-10T12:00:00Z",
            ),
        ]
        full = features(fixture(), rows)
        truncated = features(fixture(), rows[:2])
        past = full["signal_session"] <= date(2026, 3, 6)
        assert_frame_equal(full[past], truncated[past])
        self.assertTrue(row(full).sec_clock_missing)

    def test_removal_and_readdition_keep_chain_state_and_first_known_identity(self):
        rows = [
            event("chain"),
            event(
                "chain",
                observation_sequence=2,
                asset_ids=[],
                observation_recorded_at="2026-03-09T12:30:00Z",
            ),
            event(
                "chain",
                observation_sequence=3,
                asset_ids=[ASSET, OTHER],
                asset_first_seen_at={
                    ASSET: "2026-03-06T20:00:00Z",
                    OTHER: "2026-03-10T12:00:00Z",
                },
                observation_recorded_at="2026-03-10T12:00:00Z",
            ),
        ]
        both = {"asset_ids": [ASSET, OTHER]}
        full = features(fixture(), rows, **both)
        # The removal is captured before 03-09's deadline, so 03-06 sees no link; the
        # re-addition adds no second event for ASSET and counts OTHER once.
        self.assertEqual(row(full).sec_events_1d, 0)
        self.assertEqual(row(full, "2026-03-09").sec_events_1d, 0)
        self.assertEqual(row(full, "2026-03-09", OTHER).sec_events_1d, 1)
        shortened = features(fixture(), rows[:2], **both)
        before = full["signal_session"] <= date(2026, 3, 6)
        assert_frame_equal(full[before], shortened[before])

    def test_same_capture_second_uses_sequence_and_the_deadline_is_inclusive(self):
        clock = "2026-03-09T09:59:00Z"
        linked = event(
            "tie", public_at=clock, observation_recorded_at="2026-03-09T12:59:00Z"
        )
        removed = event(
            "tie",
            observation_sequence=2,
            asset_ids=[],
            public_at=clock,
            observation_recorded_at="2026-03-09T12:59:00Z",
        )
        # Same capture second: the higher sequence wins whatever the row order.
        self.assertEqual(row(features(fixture(), [removed, linked])).sec_events_1d, 0)
        for recorded, count in (
            ("2026-03-09T13:00:00Z", 0),
            ("2026-03-09T13:01:00Z", 1),
        ):
            with self.subTest(recorded=recorded):
                later = {**removed, "observation_recorded_at": recorded}
                self.assertEqual(
                    row(features(fixture(), [later, linked])).sec_events_1d, count
                )
        duplicate = {**removed, "observation_sequence": 1}
        with self.assertRaisesRegex(ValueError, "Duplicate observation_sequence"):
            features(fixture(), [duplicate, linked])


class ObservedCoverageTest(unittest.TestCase):
    def test_history_limit_late_and_disjoint_checks(self):
        material = fixture([check(asset) for asset in (ASSET, OTHER)])
        self.assertEqual(row(features(material)).sec_events_1d, 0)
        # A history-limited read is countable inside its window.
        limited = fixture(
            [check(status="partial", error_code="SOURCE_HISTORY_LIMIT"), check(OTHER)]
        )
        self.assertEqual(row(features(limited)).sec_events_1d, 0)
        # A check captured after the 09:00 New York deadline does not cover that decision
        # under observed_content; reconstruction uses it.
        for checked_at, state in (
            ("2026-03-09T13:00:00Z", "empty"),
            ("2026-03-09T13:01:00Z", "unknown"),
        ):
            with self.subTest(checked_at=checked_at):
                late = fixture([check(checked_at=checked_at), check(OTHER)])
                observed = row(features(late))
                self.assertEqual(observed.sec_coverage, state)
                self.assertEqual(pd.isna(observed.sec_events_1d), state == "unknown")
                rebuilt = row(features(late, time_policy="public_reconstructed"))
                self.assertEqual(rebuilt.sec_events_1d, 0)
        # Windows that leave the weekend before the entry session unchecked.
        disjoint = fixture(
            [
                check(checked_end="2026-03-06"),
                check(checked_start="2026-03-09"),
                check(OTHER),
            ]
        )
        for policy in (OBSERVED, "public_reconstructed"):
            with self.subTest(policy=policy):
                gap = row(features(disjoint, time_policy=policy))
                self.assertEqual(gap.sec_coverage, "unknown")
                self.assertTrue(pd.isna(gap.sec_events_1d))

    def test_later_unbounded_failure_applies_only_under_observed(self):
        failed = check(
            checked_start="",
            checked_end="",
            checked_at="2026-03-09T09:00:00Z",
            status="error",
            error_code="SOURCE_UNAVAILABLE",
        )
        material = fixture([check(checked_at=EARLY), failed, check(OTHER)])
        observed = row(features(material))
        self.assertEqual(observed.sec_coverage, "error")
        self.assertTrue(pd.isna(observed.sec_events_1d))
        rebuilt = row(features(material, time_policy="public_reconstructed"))
        self.assertEqual(rebuilt.sec_coverage, "empty")
        self.assertEqual(rebuilt.sec_events_1d, 0)
        # Before the failure was captured, the earlier countable check still decides.
        self.assertEqual(row(features(material), "2026-03-04").sec_coverage, "empty")


if __name__ == "__main__":
    unittest.main()
