"""Event counts, clocks and coverage of the 2.0 reader on synthetic material."""

from __future__ import annotations

import hashlib
import json
import random
import tempfile
import unittest
from datetime import date, timedelta
from typing import Any

import pandas as pd
from pandas.testing import assert_frame_equal

import research_datasets
from research_datasets import EventSpec, clocks
from research_datasets.events import default_specs
from research_datasets.panels import OBSERVATION_COLUMNS, _read_feature_rows
from tests import reference
from tests import test_sdk as bundle

DATASET = "00000000-0000-4000-8000-000000000001"
ASSET = "00000000-0000-4000-8000-000000000002"
OTHER = "00000000-0000-4000-8000-000000000003"
BENCHMARK = "00000000-0000-4000-8000-000000000004"
THIRD = "00000000-0000-4000-8000-000000000005"
EARLY = "2026-01-01T00:00:00Z"
LATE = "2026-11-01T00:00:00Z"


def check(asset: str = ASSET, source: str = "sec", **changes: Any) -> dict[str, Any]:
    values = {
        "source": source,
        "asset_id": asset,
        "checked_start": "2026-02-02",
        "checked_end": "2026-03-27",
        "checked_at": EARLY,
        "status": "empty",
        "error_code": "",
        "count": 0,
    }
    values.update(changes)
    return values


def fixture(
    checks: list[dict[str, Any]] | None = None, first: str = "2026-02-02"
) -> dict[str, Any]:
    calendar = [day.date() for day in pd.bdate_range(first, "2026-03-27")]
    manifest = {
        "dataset_id": DATASET,
        "cutoff_date": str(calendar[-1]),
        "source_timezones": {"sec": "America/New_York"},
    }
    bars = pd.DataFrame(
        [
            {
                "asset_id": asset,
                "date": day,
                "open": 100 + index,
                "close": 101 + index,
                "volume": 10 + index,
            }
            for asset in (ASSET, OTHER, BENCHMARK)
            for index, day in enumerate(calendar)
        ]
    )
    if checks is None:
        checks = [
            check(asset, source)
            for asset in (ASSET, OTHER)
            for source in ("sec", "alpaca_news")
        ]
    return {
        "manifest": manifest,
        "manifest_sha256": hashlib.sha256(json.dumps(manifest).encode()).hexdigest(),
        "calendar": list(map(str, calendar)),
        "universe": pd.DataFrame(
            {
                "asset_id": [ASSET, OTHER, BENCHMARK],
                "is_benchmark": [False, False, True],
            }
        ),
        "raw": bars.copy(),
        "all": bars.copy(),
        "event_observations": pd.DataFrame(),
        "source_checks": pd.DataFrame(checks),
    }


def event(uid: str = "one", **changes: Any) -> dict[str, Any]:
    public = changes.get("public_at", "2026-03-06T20:00:00Z")
    values = {
        "source": "sec",
        "event_uid": uid,
        "event_id": uid,
        "observation_id": f"{uid}-{changes.get('observation_sequence', 1)}",
        "observation_sequence": 1,
        "form": "8-K",
        "filing_date": public[:10],
        "event_date": public[:10],
        "asset_ids": [ASSET],
        "asset_first_seen_at": {ASSET: public},
        "content_first_seen_at": public,
        "observation_recorded_at": public,
        "public_time_precision": "second",
        "public_at": public,
        "public_date": "",
    }
    values.update(changes)
    return values


def article(uid: str, public: str, assets: list[str], **changes: Any) -> dict[str, Any]:
    return event(
        uid,
        source="alpaca_news",
        form=None,
        filing_date=None,
        public_at=public,
        asset_ids=assets,
        asset_first_seen_at={asset: public for asset in assets},
        **changes,
    )


def stories(pairs: list[tuple[str, str]]) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "event_id": uid,
                "source": "alpaca_news",
                "story_key": story,
                "provider_updated_at": "2026-03-06T15:00:00Z",
            }
            for uid, story in pairs
        ]
    )


def run(
    material: dict[str, Any], events: list[dict[str, Any]] = (), **changes: Any
) -> tuple[pd.DataFrame, dict[str, Any]]:
    material = {**material, "event_observations": pd.DataFrame(list(events))}
    options = {
        "dataset_id": DATASET,
        "asset_ids": [ASSET, OTHER],
        "start": material["calendar"][20],
        "end": material["calendar"][35],
        "benchmark_id": BENCHMARK,
        "time_policy": "public_reconstructed",
        "horizon": 5,
        "allow_static_universe": True,
    }
    options.update(changes)
    features, _, _, record = research_datasets.prepare(material, **options)
    return features, record


def row(frame: pd.DataFrame, day: str = "2026-03-06", asset: str = ASSET) -> Any:
    return frame[
        (frame["signal_session"] == date.fromisoformat(day))
        & (frame["asset_id"] == asset)
    ].iloc[0]


class MaterialVersion:
    """A frozen version over in-memory material, projecting reads like the client."""

    def __init__(self, material: dict[str, Any]) -> None:
        self.material = material
        self.id = DATASET
        families = (
            {"news_versions": {}} if material.get("news_versions") is not None else {}
        )
        self.manifest = {**material["manifest"], "data_families": families}
        self.manifest_sha256 = material["manifest_sha256"]
        self.calendar = material["calendar"]
        self.universe = material["universe"]

    def resolve(self, symbols: Any) -> list[str]:
        if symbols is None:
            return list(self.universe["asset_id"])
        return [symbols] if isinstance(symbols, str) else list(symbols)

    def prices(self, asset_ids: list[str], adjusted: bool) -> pd.DataFrame:
        frame = self.material["all" if adjusted else "raw"]
        return frame[frame["asset_id"].isin(asset_ids)]

    @staticmethod
    def _project(frame: pd.DataFrame, columns: Any) -> pd.DataFrame:
        if columns is None:
            return frame.copy()
        return frame[[name for name in columns if name in frame.columns]].copy()

    def event_observations(self, *, columns: Any = None) -> pd.DataFrame:
        return self._project(self.material["event_observations"], columns)

    def source_checks(self, asset_ids: list[str]) -> pd.DataFrame:
        frame = self.material["source_checks"]
        return frame[frame["asset_id"].isin(asset_ids)].copy()

    def family(self, name: str, *, columns: Any = None) -> pd.DataFrame:
        return self._project(self.material[name], columns)


def daily(
    material: dict[str, Any], events: list[dict[str, Any]] = (), **options: Any
) -> pd.DataFrame:
    """daily_features over ``material`` with ``events`` (default window 03-02..03-23)."""
    material = {**material, "event_observations": pd.DataFrame(list(events))}
    options = {
        "start": material["calendar"][20],
        "end": material["calendar"][35],
        "time_policy": "public_reconstructed",
        "benchmark": BENCHMARK,
        **options,
    }
    symbols = options.pop("symbols", [ASSET, OTHER])
    return research_datasets.daily_features(
        MaterialVersion(material), symbols, **options
    )


class LinkTest(unittest.TestCase):
    def test_m2_reconstructed_links_come_from_latest_version(self) -> None:
        # Backfill linked GOOG first; GOOGL joined in a later version at the same clock.
        events = [
            event("dual"),
            event(
                "dual",
                observation_sequence=2,
                asset_ids=[ASSET, OTHER],
                observation_recorded_at="2026-03-10T12:00:00Z",
                asset_first_seen_at={
                    ASSET: "2026-03-06T20:00:00Z",
                    OTHER: "2026-03-10T12:00:00Z",
                },
            ),
        ]
        features, _ = run(fixture(), events)
        for asset in (ASSET, OTHER):
            self.assertEqual(row(features, asset=asset).sec_new_event_count, 1)
            self.assertEqual(row(features, "2026-03-09", asset).sec_new_event_count, 0)
        reversed_order, _ = run(fixture(), events[::-1])
        assert_frame_equal(features, reversed_order)
        # The audit policy keeps association clocks: GOOGL becomes known on 03-10.
        observed, _ = run(fixture(), events, time_policy="observed_content")
        self.assertEqual(row(observed).sec_new_event_count, 1)
        self.assertEqual(row(observed, asset=OTHER).sec_new_event_count, 0)
        self.assertEqual(row(observed, "2026-03-09", OTHER).sec_new_event_count, 1)

    def test_m2_reconstructed_link_removal_is_retroactive(self) -> None:
        original = event("chain")
        removal = event(
            "chain",
            observation_sequence=2,
            asset_ids=[],
            observation_recorded_at="2026-03-09T12:30:00Z",
        )
        features, _ = run(fixture(), [original, removal])
        self.assertEqual(features["sec_new_event_count"].sum(), 0)
        # An identity relink moves the event to its interval owner from its first clock.
        moved = event(
            "chain",
            observation_sequence=3,
            asset_ids=[OTHER],
            observation_recorded_at="2026-03-20T12:00:00Z",
        )
        features, _ = run(fixture(), [original, removal, moved])
        self.assertEqual(row(features).sec_new_event_count, 0)
        self.assertEqual(row(features, asset=OTHER).sec_new_event_count, 1)
        self.assertEqual(features["sec_new_event_count"].sum(), 1)


class ClockTest(unittest.TestCase):
    def test_cutoff_is_inclusive_for_0600_public_times(self) -> None:
        # 2026-03-09 06:00 New York (EDT) is 10:00Z: the decision of signal 03-06.
        features, _ = run(
            fixture(),
            [
                event("at", public_at="2026-03-09T10:00:00Z"),
                event("after", public_at="2026-03-09T10:00:01Z", asset_ids=[OTHER]),
            ],
        )
        self.assertEqual(str(row(features).decision_at), "2026-03-09 10:00:00+00:00")
        self.assertEqual(row(features).sec_new_event_count, 1)
        self.assertEqual(row(features, asset=OTHER).sec_new_event_count, 0)
        self.assertEqual(row(features, "2026-03-09", OTHER).sec_new_event_count, 1)
        # Accepted Friday 18:10 New York with SEC filing date Monday: public Monday 06:00.
        late_filing = event(
            "late", public_at="2026-03-06T23:10:00Z", filing_date="2026-03-09"
        )
        features, _ = run(fixture(), [late_filing])
        self.assertEqual(row(features).sec_new_event_count, 1)
        late_filing["filing_date"] = "2026-03-10"
        features, _ = run(fixture(), [late_filing])
        self.assertEqual(row(features).sec_new_event_count, 0)
        self.assertEqual(row(features, "2026-03-09").sec_new_event_count, 1)
        # observed_content: a capture by 09:00 New York still meets that morning's decision.
        for recorded, signal in (
            ("2026-03-09T12:59:00Z", "2026-03-06"),
            ("2026-03-09T13:01:00Z", "2026-03-09"),
        ):
            captured = event(
                "captured",
                public_at="2026-03-09T09:00:00Z",
                content_first_seen_at=recorded,
                observation_recorded_at=recorded,
                asset_first_seen_at={ASSET: recorded},
            )
            features, _ = run(fixture(), [captured], time_policy="observed_content")
            with self.subTest(recorded=recorded):
                self.assertEqual(row(features, signal).sec_new_event_count, 1)

    def test_event_window_is_previous_to_current_decision(self) -> None:
        # 2026-03-06 06:00 New York (EST) is 11:00Z: the decision of signal 03-05.
        features, _ = run(
            fixture(),
            [
                event("boundary", public_at="2026-03-06T11:00:00Z"),
                event("inside", public_at="2026-03-06T11:00:01Z", asset_ids=[OTHER]),
            ],
        )
        today, yesterday = row(features), row(features, "2026-03-05")
        self.assertEqual(today.previous_decision_at, yesterday.decision_at)
        self.assertEqual(str(today.previous_decision_at), "2026-03-06 11:00:00+00:00")
        self.assertEqual(yesterday.sec_new_event_count, 1)
        self.assertEqual(today.sec_new_event_count, 0)
        self.assertEqual(row(features, asset=OTHER).sec_new_event_count, 1)
        self.assertEqual(row(features, "2026-03-05", OTHER).sec_new_event_count, 0)

    def test_unknown_clock_event_flags_its_date_window(self) -> None:
        dated = event(
            "dated",
            public_time_precision="unknown",
            event_date="2026-03-10",
            filing_date="2026-03-10",
        )
        features, record = run(fixture(), [dated])
        # The New York day 03-10 overlaps the windows of signals 03-09 and 03-10.
        for day, flagged in (
            ("2026-03-06", False),
            ("2026-03-09", True),
            ("2026-03-10", True),
            ("2026-03-11", False),
        ):
            with self.subTest(day=day):
                self.assertEqual(row(features, day).sec_clock_missing, flagged)
                self.assertEqual(pd.isna(row(features, day).sec_events_1d), flagged)
                self.assertEqual(row(features, day).sec_observed_events_1d, 0)
        self.assertEqual(record["undatable_events"], {})
        # observed_content places it at its capture and flags the missing public clock.
        observed, _ = run(fixture(), [dated], time_policy="observed_content")
        self.assertEqual(row(observed).sec_events_1d, 1)
        self.assertTrue(row(observed).sec_public_clock_missing)
        # An event without clock or date counts as undatable only for the selection.
        undatable = event(
            "undatable",
            public_time_precision="unknown",
            event_date="",
            filing_date="",
            asset_ids=[OTHER],
        )
        for selection, expected in (
            ([ASSET], {}),
            ([ASSET, OTHER], {"sec": 1}),
            ([OTHER], {"sec": 1}),
        ):
            with self.subTest(selection=selection):
                _, record = run(fixture(), [undatable], asset_ids=selection)
                self.assertEqual(record["undatable_events"], expected)


class CoverageTest(unittest.TestCase):
    def test_m3_reconstructed_coverage_ignores_check_clock(self) -> None:
        material = fixture([check(checked_at=LATE), check(OTHER, checked_at=EARLY)])
        features, record = run(material, [event()])
        late = row(features)
        self.assertEqual(late.sec_coverage, "empty")
        self.assertEqual(late.sec_coverage_basis, "reconstructed")
        self.assertEqual(late.sec_new_event_count, 1)
        self.assertEqual(row(features, asset=OTHER).sec_coverage_basis, "observed")
        coverage = record["source_coverage"]["sec"]
        self.assertEqual(coverage["first_covered_session"], "2026-03-02")
        self.assertEqual(coverage["basis"], {"observed": 16, "reconstructed": 16})
        observed, _ = run(material, [event()], time_policy="observed_content")
        self.assertEqual(row(observed).sec_coverage, "unknown")
        self.assertTrue(pd.isna(row(observed).sec_new_event_count))
        self.assertEqual(row(observed, asset=OTHER).sec_coverage, "empty")

    def test_m3_veto_overrides_earlier_read_and_later_read_restores(self) -> None:
        for code in sorted(research_datasets.VETO_CODES):
            veto = check(
                status="partial",
                error_code=code,
                checked_start="2026-03-04",
                checked_end="2026-03-15",
                checked_at="2026-11-02T00:00:00Z",
            )
            reread = check(
                status="checked",
                checked_start="2026-03-05",
                checked_end="2026-03-10",
                checked_at="2026-11-03T00:00:00Z",
            )
            with self.subTest(code=code):
                features, _ = run(fixture([check(checked_at=LATE), veto]), [event()])
                self.assertEqual(row(features).sec_coverage, "mapping_missing")
                self.assertTrue(pd.isna(row(features).sec_new_event_count))
                self.assertEqual(row(features).sec_observed_new_event_count, 1)
                self.assertEqual(row(features, "2026-03-02").sec_coverage, "empty")
                features, _ = run(
                    fixture([check(checked_at=LATE), veto, reread]), [event()]
                )
                self.assertEqual(row(features).sec_coverage, "checked")
                self.assertEqual(row(features).sec_new_event_count, 1)
                self.assertEqual(
                    row(features, "2026-03-12").sec_coverage, "mapping_missing"
                )

    def test_m3_later_truncated_read_does_not_erase_reconstructed_coverage(
        self,
    ) -> None:
        for code in ("SOURCE_RESULT_BOUNDARY", "SOURCE_ROW_REJECTED"):
            truncated = check(
                status="partial", error_code=code, checked_at="2026-11-05T00:00:00Z"
            )
            with self.subTest(code=code):
                features, _ = run(fixture([check(checked_at=LATE), truncated]))
                self.assertEqual(row(features).sec_coverage, "empty")
                features, _ = run(fixture([truncated]))
                self.assertEqual(row(features).sec_coverage, "partial")
                self.assertTrue(pd.isna(row(features).sec_new_event_count))

    def test_alpaca_news_complete_read_counts_and_truncated_read_does_not(
        self,
    ) -> None:
        news = event("article", source="alpaca_news", form=None, filing_date=None)
        for code, label in (
            ("SOURCE_PUBLICATION_COVERAGE_UNKNOWN", "read_complete"),
            ("SOURCE_RESULT_BOUNDARY", "partial"),
        ):
            material = fixture(
                [check(source="alpaca_news", status="partial", error_code=code)]
            )
            with self.subTest(code=code):
                features, _ = run(material, [news])
                self.assertEqual(row(features).alpaca_news_coverage, label)
                self.assertEqual(
                    pd.notna(row(features).alpaca_news_new_event_count),
                    label == "read_complete",
                )

    def test_not_listed_code_is_na_not_veto(self) -> None:
        not_listed = check(
            status="partial",
            error_code="IDENTITY_NOT_LISTED",
            checked_at="2026-11-02T00:00:00Z",
        )
        features, record = run(fixture([check(checked_at=LATE), not_listed]))
        self.assertEqual(row(features).sec_coverage, "not_listed")
        self.assertTrue(pd.isna(row(features).sec_new_event_count))
        states = record["source_coverage"]["sec"]["states"]
        self.assertNotIn("mapping_missing", states)
        self.assertEqual(states["not_listed"], 16)

    def test_first_covered_session_and_info_regime_in_run_record(self) -> None:
        checks = [
            check(checked_end="2026-03-10"),
            check(source="alpaca_news", checked_start="2026-03-05", checked_at=LATE),
        ]
        regimes = {
            "public_reconstructed": {
                "2026-03-04": "observed",
                "2026-03-05": "mixed",
                "2026-03-09": "mixed",
                "2026-03-10": "reconstructed",
                "2026-03-23": "reconstructed",
            },
            # A check saved after the decision is invisible to observed_content.
            "observed_content": {
                "2026-03-04": "observed",
                "2026-03-09": "observed",
                "2026-03-10": "",
            },
        }
        firsts = {
            "public_reconstructed": ("2026-03-02", "2026-03-05"),
            "observed_content": ("2026-03-02", None),
        }
        for policy, expected in regimes.items():
            with self.subTest(policy=policy):
                features, record = run(fixture(checks), time_policy=policy)
                for day, regime in expected.items():
                    self.assertEqual(row(features, day).info_regime, regime)
                    self.assertEqual(row(features, day, OTHER).info_regime, "")
                coverage = record["source_coverage"]
                self.assertEqual(
                    (
                        coverage["sec"]["first_covered_session"],
                        coverage["alpaca_news"]["first_covered_session"],
                    ),
                    firsts[policy],
                )
                self.assertEqual(coverage["sec"]["basis"], {"observed": 6})
                self.assertEqual(coverage["sec"]["assets_with_coverage"], 1)
                self.assertIsNone(coverage["finnhub_news"]["first_covered_session"])
        self.assertEqual(coverage["alpaca_news"]["basis"], {})
        self.assertEqual(
            record["source_coverage"]["alpaca_news"]["states"], {"unknown": 32}
        )

    def test_inverted_check_window_is_ignored(self) -> None:
        # A window ending before it starts is malformed; the unbounded check decides.
        material = fixture(
            [
                check(checked_start=None, checked_end=None, status="checked"),
                check(checked_start="2026-03-10", checked_end="2026-03-09"),
            ]
        )
        window = {"start": material["calendar"][20], "end": material["calendar"][35]}
        for policy, label in (
            ("public_reconstructed", "unknown"),
            ("observed_content", "checked"),
        ):
            with self.subTest(policy=policy):
                features, _ = run(
                    material, time_policy=policy, asset_ids=[ASSET], **window
                )
                self.assertEqual(row(features, "2026-03-09").sec_coverage, label)
                expected, _ = reference.features(
                    material,
                    asset_ids=[ASSET],
                    population=[ASSET, OTHER],
                    policy=policy,
                    **window,
                )
                self.assertEqual(
                    features["sec_coverage"].astype(str).tolist(),
                    expected["sec_coverage"].tolist(),
                )


class CountSpecTest(unittest.TestCase):
    def test_event_spec_filters_latest_attributes_and_items(self) -> None:
        later = {"observation_sequence": 2}
        filings = [
            event("results", items="2.02,9.01", type="current"),
            event("officer", items="5.02", type="current"),
            event("quarterly", form="10-Q", items="2.02"),
            # A later version names another item: reconstruction reads the latest
            # version, observed_content the one selected at the decision.
            event("revised", items="2.02"),
            event(
                "revised",
                items="5.02",
                observation_recorded_at="2026-03-20T12:00:00Z",
                **later,
            ),
            # A later version without items keeps the earlier list.
            event("kept", items="2.02"),
            event(
                "kept",
                items=None,
                observation_recorded_at="2026-03-07T12:00:00Z",
                **later,
            ),
        ]
        specs = [
            EventSpec("sec_results", "sec", {"form": {"8-K"}}, {"2.02"}),
            EventSpec("sec_current", "sec", {"type": {"current"}}),
        ]
        for policy, results in (("public_reconstructed", 2), ("observed_content", 3)):
            with self.subTest(policy=policy):
                features = daily(fixture(), filings, time_policy=policy, specs=specs)
                self.assertEqual(row(features).sec_results_events_1d, results)
                self.assertEqual(row(features).sec_current_events_1d, 2)
                self.assertEqual(row(features, asset=OTHER).sec_results_events_1d, 0)
                record = features.attrs["provenance"]
                self.assertEqual(list(record["source_coverage"]), ["sec"])
                self.assertEqual(list(record["source_coverage_counts"]), ["sec"])
                self.assertEqual(
                    record["parameters"]["event_specs"][0],
                    {
                        "name": "sec_results",
                        "source": "sec",
                        "where": {"form": ["8-K"]},
                        "items_any": ["2.02"],
                    },
                )
        names = [name for name in features if name.startswith("sec")]
        self.assertIn("sec_results_events_rank_21d", names)
        self.assertIn("sec_current_events_63d", names)
        self.assertFalse(
            [
                name
                for name in names
                if not name.startswith(("sec_results", "sec_current"))
            ]
        )
        # Default specs: every legacy form counts, items are not filtered.
        defaults = daily(fixture(), filings, symbols=[ASSET, ASSET])
        self.assertEqual(row(defaults).sec_events_1d, 5)
        self.assertEqual(len(defaults), 16)
        # A filter on a column the observations lack is refused, except the legacy
        # form filter of bundles saved before form.
        with self.assertRaisesRegex(ValueError, "CAPABILITY_MISSING"):
            daily(fixture(), filings, specs=[EventSpec("x", "sec", {"kind": {"a"}})])
        proxy = [*filings, event("proxy", form="DEF 14A")]
        self.assertEqual(row(daily(fixture(), proxy)).sec_events_1d, 5)
        formless = [
            {key: value for key, value in item.items() if key != "form"}
            for item in proxy
        ]
        self.assertEqual(row(daily(fixture(), formless)).sec_events_1d, 6)
        with self.assertRaisesRegex(ValueError, "CAPABILITY_MISSING"):
            daily(fixture(), formless, specs=specs[:1])
        for broken in ({"form": "8-K"}, {"form": [1]}):
            with self.subTest(where=broken), self.assertRaises(ValueError):
                EventSpec("broken", "sec", broken)
        with self.assertRaisesRegex(ValueError, "unique"):
            daily(fixture(), filings, specs=[specs[0], specs[0]])

    def test_rolling_counts_nan_unless_every_window_countable(self) -> None:
        cal = [str(day.date()) for day in pd.bdate_range("2025-12-01", "2026-03-27")]
        clocked = "2025-11-01T00:00:00Z"
        # Day cal[8] is not covered: windows 7 and 8 are not countable.
        checks = [
            check(checked_start=cal[0], checked_end=cal[7], checked_at=clocked),
            check(checked_start=cal[9], checked_end=cal[-1], checked_at=clocked),
        ]
        filings = [
            event(f"e{index}", public_at=f"{cal[index]}T15:00:00Z")
            for index in (10, 68, 72)
        ]
        # Under public_reconstructed a clock-less event dated cal[76] leaves windows
        # 75 and 76 unknown.
        dateonly = event(
            "dateonly",
            public_time_precision="unknown",
            event_date=cal[76],
            filing_date=cal[76],
        )
        common = {
            # signal: (5d, 21d, 63d); warm-up windows before the first signal count.
            70: (1, 1, None),
            71: (1, 1, 2),
            72: (2, 2, 3),
            73: (1, 2, 2),
            74: (1, 2, 2),
        }
        cases = {
            "public_reconstructed": (
                [*filings, dateonly],
                {75: (None,) * 3, 80: (None,) * 3, 81: (0, None, None)},
            ),
            "observed_content": (
                filings,
                {75: (1, 2, 2), 80: (0, 2, 2), 81: (0, 2, 2)},
            ),
        }
        material = fixture(checks, first=cal[0])
        for policy, (items, tail) in cases.items():
            window = {"time_policy": policy, "end": cal[-2], "symbols": [ASSET]}
            features = daily(material, items, start=cal[70], **window)
            for index, sums in {**common, **tail}.items():
                with self.subTest(policy=policy, signal=cal[index]):
                    current = row(features, cal[index])
                    for size, value in zip((5, 21, 63), sums):
                        total = current[f"sec_events_{size}d"]
                        if value is None:
                            self.assertTrue(pd.isna(total), size)
                        else:
                            self.assertEqual(total, value, size)
            # Warm-up gives the sums of a run over the whole calendar.
            full = daily(material, items, start=cal[0], **window)
            later = full["signal_session"] >= date.fromisoformat(cal[70])
            assert_frame_equal(
                features,
                full[later].reset_index(drop=True),
                check_categorical=False,
            )
            # Fewer windows than the sum needs leave it missing.
            self.assertTrue(pd.isna(row(full, cal[3]).sec_events_5d))
            self.assertEqual(row(full, cal[4]).sec_events_5d, 0)

    def test_story_key_dedupes_counts(self) -> None:
        articles = [
            article("n1", "2026-03-06T15:00:00Z", [ASSET]),
            article("n2", "2026-03-06T18:00:00Z", [ASSET, OTHER]),
            article("n3", "2026-03-10T15:00:00Z", [ASSET]),
            article("n4", "2026-03-06T16:00:00Z", [ASSET]),
        ]
        versions = stories(
            [("n1", "story-a"), ("n2", "story-a"), ("n3", "story-a"), ("n4", "story-b")]
        )
        material = fixture()
        undeduped, _ = run(material, articles)
        self.assertEqual(row(undeduped).alpaca_news_new_event_count, 3)
        for policy in ("public_reconstructed", "observed_content"):
            with self.subTest(policy=policy):
                features, _ = run(
                    {**material, "news_versions": versions},
                    articles,
                    time_policy=policy,
                )
                self.assertEqual(row(features).alpaca_news_new_event_count, 2)
                # A story repeated after 72 h is new; OTHER first appears in n2.
                self.assertEqual(
                    row(features, "2026-03-10").alpaca_news_new_event_count, 1
                )
                self.assertEqual(
                    row(features, asset=OTHER).alpaca_news_new_event_count, 1
                )

    def test_story_dedupe_ignores_an_anchor_no_longer_linked(self) -> None:
        # x first linked ASSET, then a later version dropped the link; y of the
        # same story stays linked, so the story still counts once for ASSET.
        articles = [
            article("x", "2026-03-06T15:00:00Z", [ASSET]),
            article(
                "x",
                "2026-03-06T15:00:00Z",
                [],
                observation_sequence=2,
                observation_recorded_at="2026-03-06T16:00:00Z",
            ),
            article("y", "2026-03-06T17:00:00Z", [ASSET]),
        ]
        material = {**fixture(), "news_versions": stories([("x", "s"), ("y", "s")])}
        for policy in ("public_reconstructed", "observed_content"):
            with self.subTest(policy=policy):
                features, _ = run(material, articles, time_policy=policy)
                self.assertEqual(row(features).alpaca_news_new_event_count, 1)

    def test_sec_form_filter_falls_back_to_the_latest_named_form(self) -> None:
        unnamed = [
            event("s1"),
            event(
                "s1",
                observation_sequence=2,
                form=None,
                observation_recorded_at="2026-03-07T12:00:00Z",
            ),
        ]
        # A later non-legacy form: reconstruction uses it, observed_content uses
        # the version selected at the decision.
        renamed = [
            event("s2"),
            event(
                "s2",
                observation_sequence=2,
                form="DEF 14A",
                observation_recorded_at="2026-03-20T12:00:00Z",
            ),
        ]
        for events, policy, expected in (
            (unnamed, "public_reconstructed", 1),
            (unnamed, "observed_content", 1),
            (renamed, "public_reconstructed", 0),
            (renamed, "observed_content", 1),
        ):
            with self.subTest(event=events[0]["event_uid"], policy=policy):
                features, _ = run(fixture(), events, time_policy=policy)
                self.assertEqual(row(features).sec_new_event_count, expected)

    def test_sec_counts_keep_legacy_forms(self) -> None:
        forms = ["8-K", "10-K/A", "6-K", "4", "SC 13D", "25-NSE", "DEF 14A", None]
        events = [
            event(f"filing-{index}", form=form) for index, form in enumerate(forms)
        ]
        features, _ = run(fixture(), events)
        self.assertEqual(row(features).sec_new_event_count, 3)
        self.assertEqual(
            research_datasets.LEGACY_SEC_COUNT_FORMS,
            frozenset({"8-K", "10-K", "10-Q", "6-K", "20-F"}),
        )

    def test_sec_earnings_release_produces_no_counts(self) -> None:
        events = [
            event("filing"),
            event("release", source="sec_earnings_release"),
            event("action", source="alpaca_actions", public_time_precision="unknown"),
            event("calendar", source="finnhub_earnings"),
        ]
        checks = [
            check(source=source)
            for source in (
                "sec",
                "sec_earnings_release",
                "alpaca_actions",
                "finnhub_earnings",
            )
        ]
        features, record = run(fixture(checks), events)
        self.assertEqual(row(features).sec_new_event_count, 1)
        for source in ("sec_earnings_release", "alpaca_actions", "finnhub_earnings"):
            self.assertEqual([name for name in features if name.startswith(source)], [])
            self.assertNotIn(source, record["source_coverage"])
        self.assertEqual(record["skipped_sources"], {})

    def test_rolling_counts_and_ranks_need_complete_windows(self) -> None:
        events = [
            event("a", public_at="2026-02-10T15:00:00Z"),
            *(
                event(
                    f"b{index}", public_at="2026-02-10T15:00:00Z", asset_ids=[BENCHMARK]
                )
                for index in range(2)
            ),
        ]
        checks = [check(asset) for asset in (ASSET, OTHER, BENCHMARK)]
        features, record = run(
            fixture(checks), events, asset_ids=[ASSET, OTHER, BENCHMARK]
        )
        first = "2026-03-02"
        self.assertEqual(row(features, first).sec_events_21d, 1)
        self.assertEqual(row(features, first, BENCHMARK).sec_events_21d, 2)
        self.assertEqual(row(features, first).sec_events_rank_21d, 1.0)
        self.assertEqual(row(features, first, OTHER).sec_events_rank_21d, 0.5)
        self.assertTrue(pd.isna(row(features, first, BENCHMARK).sec_events_rank_21d))
        self.assertEqual(record["source_coverage"]["sec"]["assets_with_coverage"], 3)
        # One uncovered day inside the 21 windows leaves the rolling count missing.
        checks[0] = check(checked_start="2026-02-04")
        features, _ = run(fixture(checks), events, asset_ids=[ASSET, OTHER])
        self.assertTrue(pd.isna(row(features, first).sec_events_21d))
        self.assertEqual(row(features, "2026-03-04").sec_events_21d, 1)

    def test_rank_population_is_the_non_benchmark_universe(self) -> None:
        events = [event("a", public_at="2026-02-10T15:00:00Z")]
        checks = [check(asset) for asset in (ASSET, OTHER, BENCHMARK)]
        first = "2026-03-02"
        material = fixture(checks)
        # Without is_benchmark flags the explicit benchmark still leaves the population.
        unflagged = {**material, "universe": material["universe"][["asset_id"]]}
        for name, base, selection in (
            ("flagged", material, [ASSET, OTHER]),
            ("flagged", material, [ASSET, OTHER, BENCHMARK]),
            ("explicit", unflagged, [ASSET, OTHER, BENCHMARK]),
        ):
            with self.subTest(name=name, selection=len(selection)):
                features, record = run(base, events, asset_ids=selection)
                self.assertEqual(row(features, first).sec_events_rank_21d, 1.0)
                self.assertEqual(row(features, first, OTHER).sec_events_rank_21d, 0.5)
                self.assertEqual(
                    record["rank_population"],
                    {
                        "basis": "universe_non_benchmark",
                        "members": 2,
                        "selected": 2,
                        "ranked": True,
                    },
                )
        # A partial selection still ranks against the whole population.
        features, record = run(material, events, asset_ids=[ASSET])
        self.assertEqual(row(features, first).sec_events_rank_21d, 1.0)
        self.assertEqual(row(features, first).sec_events_21d, 1)
        self.assertEqual(record["rank_population"]["selected"], 1)
        self.assertTrue(record["rank_population"]["ranked"])
        self.assertEqual(record["source_coverage"]["sec"]["assets_with_coverage"], 1)
        alone, _ = run(material, events, asset_ids=[OTHER])
        self.assertEqual(row(alone, first, OTHER).sec_events_rank_21d, 0.5)


RANDOM_SPECS = (
    *default_specs(),
    EventSpec("sec_results", "sec", {"form": {"8-K"}}, {"2.02"}),
    EventSpec("news_typed", "alpaca_news", {"type": {"x", "z"}}),
)


def random_material(seed: int) -> tuple[dict[str, Any], list[str], int]:
    """Version chains with adds, removals, missing and tied clocks, plus checks
    (some with inverted windows), over more sessions than the 63-session sums."""
    rng = random.Random(seed)
    calendar = [
        day.date()
        for day in pd.bdate_range("2026-01-05", "2026-04-17")
        if day.date() != date(2026, 4, 3)
    ]
    pool = []
    for day in rng.sample(calendar, 8):
        decision = clocks.decision_at(day)
        for seconds in (0, 1, -1, 10_800, 10_801):
            pool.append(decision + timedelta(seconds=seconds))
    span = (calendar[-1] - calendar[0]).days + 10
    for _ in range(12):
        pool.append(
            pd.Timestamp(calendar[0], tz="UTC")
            + timedelta(minutes=rng.randrange((span - 5) * 1440) - 5 * 1440)
        )
    pool.append(pd.Timestamp("2026-11-01T00:00:00Z"))

    def instant() -> Any:
        value, style = rng.choice(pool), rng.random()
        if style < 0.05:
            return rng.choice([None, "", "not a time", "2026-03-05T10:00:00"])
        if style < 0.1:
            return value
        if style < 0.4:
            return value.tz_convert("America/New_York").isoformat()
        return value.strftime("%Y-%m-%dT%H:%M:%SZ")

    def day_text() -> Any:
        return rng.choice(
            [None, "", str(rng.choice(calendar) + timedelta(days=rng.randint(-3, 3)))]
        )

    assets = [ASSET, OTHER, THIRD, BENCHMARK]
    rows: list[dict[str, Any]] = []
    stories = []
    for number in range(rng.randint(20, 40)):
        source = rng.choice(
            ["sec", "sec", "alpaca_news", "finnhub_news", "sec_earnings_release"]
        )
        uid = f"{source}-{number}"
        if source == "alpaca_news" and rng.random() < 0.6:
            stories.append((uid, rng.choice(["s1", "s2", "s3"])))
        for sequence in rng.sample(range(10), rng.randint(1, 4)):
            links = rng.sample(assets, rng.randint(0, 3))
            first_seen = {asset: instant() for asset in links if rng.random() < 0.85}
            row = {
                "source": source,
                "event_uid": uid,
                "event_id": uid,
                "observation_sequence": sequence,
                "form": rng.choice(["8-K", "10-K/A", "4", None, "DEF 14A"])
                if source == "sec"
                else None,
                "filing_date": rng.choice([day_text(), "2026-13-45"])
                if source == "sec"
                else None,
                "event_date": day_text(),
                "items": rng.choice([None, "", "2.02", "9.01, 2.02", "5.02"]),
                "type": rng.choice([None, "", "x", "y", "z"]),
                "asset_ids": links,
                "asset_first_seen_at": first_seen
                if rng.random() < 0.5
                else list(first_seen.items()),
                "content_first_seen_at": instant(),
                "observation_recorded_at": instant(),
                "public_time_precision": rng.choice(
                    ["second"] * 5 + ["date", "unknown", None]
                ),
                "public_at": instant(),
                "public_date": day_text(),
            }
            if source == "alpaca_news" and rng.random() < 0.2:
                row["story_key"] = rng.choice(["s1", "s2"])
            rows.append(row)
    for source in ("future_x", None, ""):
        rows.append(event(f"skip-{source}", source=source))
    checks = []
    for asset in assets:
        for source in ("sec", "alpaca_news", "finnhub_news"):
            if rng.random() < 0.7:
                code = rng.choice(["", "SOURCE_PUBLICATION_COVERAGE_UNKNOWN"])
                checks.append(
                    check(
                        asset,
                        source,
                        checked_start=str(calendar[0]),
                        checked_end=str(calendar[-1]),
                        checked_at=rng.choice([instant(), EARLY]),
                        status="partial" if code else rng.choice(["checked", "empty"]),
                        error_code=code,
                    )
                )
            for _ in range(rng.randint(0, 4)):
                start = rng.choice(calendar) + timedelta(days=rng.randint(-4, 2))
                bounded = rng.random() < 0.85
                checks.append(
                    check(
                        asset,
                        source,
                        checked_start=str(start) if bounded else rng.choice([None, ""]),
                        checked_end=str(start + timedelta(days=rng.randint(-2, 20))),
                        checked_at=instant(),
                        status=rng.choice(
                            ["checked", "empty", "not_changed", "partial", "partial"]
                            + ["error", "odd"]
                        ),
                        error_code=rng.choice(
                            ["", "", None, "SOURCE_HISTORY_LIMIT"]
                            + ["SOURCE_PUBLICATION_COVERAGE_UNKNOWN"]
                            + ["SOURCE_RESULT_BOUNDARY", "SOURCE_SYMBOL_UNVERIFIED"]
                            + ["IDENTITY_NOT_LISTED", "SEC_PREDECESSOR_UNMAPPED"]
                        ),
                    )
                )
    material = fixture(checks)
    material["calendar"] = list(map(str, calendar))
    material["manifest"]["source_timezones"]["finnhub_news"] = rng.choice(
        ["Asia/Tokyo", "Europe/London", "America/New_York"]
    )
    material["universe"] = pd.DataFrame(
        {"asset_id": assets, "is_benchmark": [False, False, False, True]}
    )
    material["event_observations"] = pd.DataFrame(rows)
    material["news_versions"] = (
        pd.DataFrame(
            [
                {"event_id": uid, "story_key": story, "provider_updated_at": None}
                for uid, story in stories
            ]
        )
        if stories
        else None
    )
    return material, rng.sample(assets[:3], rng.randint(1, 3)), rng.choice([3, 30, 66])


class ReferenceTest(unittest.TestCase):
    def test_sampled_rows_keep_daily_coverage_and_full_population_ranks(self) -> None:
        material, _, _ = random_material(3)
        version = MaterialVersion(material)
        signal_days = sorted(
            {
                clocks.day(day)
                for day in [*version.calendar[20::7], version.calendar[-1]]
            }
        )
        options = {
            "start": signal_days[0],
            "end": signal_days[-1],
            "benchmark": BENCHMARK,
            "specs": RANDOM_SPECS,
        }
        for policy in research_datasets.POLICIES:
            with self.subTest(policy=policy):
                daily = research_datasets.daily_features(
                    version, [ASSET, OTHER], time_policy=policy, **options
                )
                sampled, summary, _ = _read_feature_rows(
                    version,
                    [ASSET, OTHER],
                    time_policy=policy,
                    next_session=None,
                    output_days=signal_days,
                    **options,
                )
                expected = daily[daily["signal_session"].isin(signal_days)].reset_index(
                    drop=True
                )
                assert_frame_equal(sampled, expected, check_exact=True)
                for name in (
                    "source_coverage",
                    "rank_population",
                    "skipped_sources",
                    "undatable_events",
                ):
                    self.assertEqual(summary[name], daily.attrs["provenance"][name])

    def test_vectorized_events_and_coverage_match_reference(self) -> None:
        seen = dict.fromkeys(
            ["inverted", "sec_results", "news_typed", *research_datasets.POLICIES], 0
        )
        for seed in range(50):
            material, selection, first = random_material(seed)
            checks = material["source_checks"]
            bounded = checks["checked_start"].fillna("") != ""
            seen["inverted"] += int(
                (
                    checks["checked_start"][bounded] > checks["checked_end"][bounded]
                ).sum()
            )
            options = {
                "start": material["calendar"][first],
                "end": material["calendar"][-1],
            }
            for policy in research_datasets.POLICIES:
                with self.subTest(seed=seed, policy=policy):
                    features = research_datasets.daily_features(
                        MaterialVersion(material),
                        selection,
                        time_policy=policy,
                        benchmark=BENCHMARK,
                        specs=RANDOM_SPECS,
                        **options,
                    )
                    record = features.attrs["provenance"]
                    expected, summary = reference.features(
                        material,
                        asset_ids=selection,
                        population=[ASSET, OTHER, THIRD],
                        policy=policy,
                        specs=RANDOM_SPECS,
                        **options,
                    )
                    actual = features[list(expected.columns)].copy()
                    for name in actual:
                        if isinstance(actual[name].dtype, pd.CategoricalDtype):
                            actual[name] = actual[name].astype(str).astype(object)
                    assert_frame_equal(actual, expected)
                    self.assertEqual(
                        record["skipped_sources"], summary["skipped_sources"]
                    )
                    self.assertEqual(
                        record["undatable_events"], summary["undatable_events"]
                    )
                    seen[policy] += int(features["sec_events_63d"].notna().sum())
                    for name in ("sec_results", "news_typed"):
                        seen[name] += int(features[f"{name}_observed_events_1d"].sum())
                    shuffled = material["event_observations"].sample(
                        frac=1, random_state=seed
                    )
                    again = research_datasets.daily_features(
                        MaterialVersion({**material, "event_observations": shuffled}),
                        selection,
                        time_policy=policy,
                        benchmark=BENCHMARK,
                        specs=RANDOM_SPECS,
                        **options,
                    )
                    assert_frame_equal(again, features)
        # The comparison is not vacuous: long sums, malformed windows and filters occur.
        self.assertTrue(all(seen.values()), seen)


class UnknownSourceTest(unittest.TestCase):
    def test_m9_unknown_source_is_skipped_and_counted(self) -> None:
        objects, _ = bundle._build_synthetic_bundle()
        with (
            bundle.SyntheticDatasetServer(objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = research_datasets.load(
                bundle.DATASET_ID,
                key=bundle.TOKEN,
                base_url=server.base_url,
                cache_dir=tmp,
            )
            window = {"start": ds.calendar[6], "end": ds.calendar[10]}
            daily = ds.daily_features(
                ["AAPL", "GOOG"], time_policy="public_reconstructed", **window
            )
            self.assertEqual(
                daily.attrs["provenance"]["skipped_sources"], {"future_x": 1}
            )
            news_day = daily[
                daily["signal_session"] == date.fromisoformat(ds.calendar[7])
            ]
            # Two articles of one story count once; coverage is a complete read.
            self.assertEqual(news_day["alpaca_news_new_event_count"].tolist(), [1, 1])
            self.assertEqual(set(news_day["alpaca_news_coverage"]), {"read_complete"})
            panel = ds.panel(
                ["AAPL"],
                time_policy="public_reconstructed",
                allow_static_universe=True,
                **window,
            )
            self.assertEqual(
                panel.attrs["provenance"]["skipped_sources"], {"future_x": 1}
            )
            _, _, _, record = research_datasets.prepare(
                ds,
                dataset_id=bundle.DATASET_ID,
                asset_ids=[bundle.ASSET_A],
                benchmark_id=bundle.BENCH_SPY,
                time_policy="observed_content",
                allow_static_universe=True,
                **window,
            )
            self.assertEqual(record["skipped_sources"], {"future_x": 1})
            self.assertEqual(record["package_version"], research_datasets.__version__)
            self.assertEqual(record["code_sha256"], research_datasets.code_digest())
            # The reader loads only the observation columns it needs, when present.
            projected = ds.event_observations(columns=["source", "event_uid", "nope"])
            self.assertEqual(list(projected.columns), ["source", "event_uid"])


class ProjectionTest(unittest.TestCase):
    def test_filtered_projected_observation_read_keeps_removal_versions(self) -> None:
        sessions = bundle.SESSIONS
        public = f"{sessions[3]}T15:00:00Z"
        removal = bundle.observation(
            "rel-1",
            "sec",
            [],
            public,
            observation_sequence=2,
            observation_recorded_at=f"{sessions[9]}T12:00:00Z",
            asset_first_seen_at={bundle.ASSET_A: public},
        )
        observations = [
            *bundle.default_observations(),
            bundle.observation("rel-1", "sec", [bundle.ASSET_A], public),
            removal,
        ]
        objects, _ = bundle._build_synthetic_bundle(observations=observations)
        with (
            bundle.SyntheticDatasetServer(objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = research_datasets.load(
                bundle.DATASET_ID,
                key=bundle.TOKEN,
                base_url=server.base_url,
                cache_dir=tmp,
            )
            wanted = list(OBSERVATION_COLUMNS)
            full = ds.event_observations(["AAPL"])
            projected = ds.event_observations(["AAPL"], columns=wanted)
            # Requested columns the version has, in request order, with full rows.
            self.assertEqual(
                list(projected.columns), [name for name in wanted if name in full]
            )
            assert_frame_equal(projected, full[list(projected.columns)])
            chain = projected[projected["event_uid"] == "rel-1"]
            self.assertEqual(chain["observation_sequence"].tolist(), [1, 2])
            self.assertEqual(len(chain["asset_ids"].iloc[1]), 0)
            self.assertEqual(
                clocks.mapping(chain["asset_first_seen_at"].iloc[1]),
                {bundle.ASSET_A: public},
            )
            other = ds.event_observations(["GOOG"], columns=wanted)
            self.assertNotIn("rel-1", other["event_uid"].tolist())
            # The removal is retroactive under public_reconstructed only.
            window = {"start": sessions[2], "end": sessions[4]}
            for policy, expected in (
                ("public_reconstructed", 0),
                ("observed_content", 1),
            ):
                with self.subTest(policy=policy):
                    daily = ds.daily_features(["AAPL"], time_policy=policy, **window)
                    self.assertEqual(
                        row(daily, sessions[3], bundle.ASSET_A).sec_events_1d,
                        expected,
                    )


if __name__ == "__main__":
    unittest.main()
