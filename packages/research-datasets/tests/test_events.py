"""Event counts, clocks and coverage of the 2.0 reader on synthetic material."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from datetime import date
from typing import Any

import pandas as pd
from pandas.testing import assert_frame_equal

import research_datasets
from tests import test_sdk as bundle

DATASET = "00000000-0000-4000-8000-000000000001"
ASSET = "00000000-0000-4000-8000-000000000002"
OTHER = "00000000-0000-4000-8000-000000000003"
BENCHMARK = "00000000-0000-4000-8000-000000000004"
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


def fixture(checks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    calendar = [day.date() for day in pd.bdate_range("2026-02-02", "2026-03-27")]
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
    }
    options.update(changes)
    features, _, _, record = research_datasets.prepare(material, **options)
    return features, record


def row(frame: pd.DataFrame, day: str = "2026-03-06", asset: str = ASSET) -> Any:
    return frame[
        (frame["signal_session"] == date.fromisoformat(day))
        & (frame["asset_id"] == asset)
    ].iloc[0]


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


class CountSpecTest(unittest.TestCase):
    def test_story_key_dedupes_counts(self) -> None:
        def article(uid: str, public: str, assets: list[str]) -> dict[str, Any]:
            return event(
                uid,
                source="alpaca_news",
                form=None,
                filing_date=None,
                public_at=public,
                asset_ids=assets,
                asset_first_seen_at={asset: public for asset in assets},
            )

        articles = [
            article("n1", "2026-03-06T15:00:00Z", [ASSET]),
            article("n2", "2026-03-06T18:00:00Z", [ASSET, OTHER]),
            article("n3", "2026-03-10T15:00:00Z", [ASSET]),
            article("n4", "2026-03-06T16:00:00Z", [ASSET]),
        ]
        versions = pd.DataFrame(
            [
                {
                    "event_id": uid,
                    "source": "alpaca_news",
                    "story_key": story,
                    "provider_updated_at": "2026-03-06T15:00:00Z",
                }
                for uid, story in (
                    ("n1", "story-a"),
                    ("n2", "story-a"),
                    ("n3", "story-a"),
                    ("n4", "story-b"),
                )
            ]
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
        features, _ = run(fixture(checks), events, asset_ids=[ASSET, OTHER, BENCHMARK])
        first = "2026-03-02"
        self.assertEqual(row(features, first).sec_events_21d, 1)
        self.assertEqual(row(features, first, BENCHMARK).sec_events_21d, 2)
        self.assertEqual(row(features, first).sec_events_rank_21d, 1.0)
        self.assertEqual(row(features, first, OTHER).sec_events_rank_21d, 0.5)
        self.assertTrue(pd.isna(row(features, first, BENCHMARK).sec_events_rank_21d))
        # One uncovered day inside the 21 windows leaves the rolling count missing.
        checks[0] = check(checked_start="2026-02-04")
        features, _ = run(fixture(checks), events, asset_ids=[ASSET, OTHER])
        self.assertTrue(pd.isna(row(features, first).sec_events_21d))
        self.assertEqual(row(features, "2026-03-04").sec_events_21d, 1)


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
            panel = ds.panel(["AAPL"], time_policy="public_reconstructed", **window)
            self.assertEqual(
                panel.attrs["provenance"]["skipped_sources"], {"future_x": 1}
            )
            _, _, _, record = research_datasets.prepare(
                ds,
                dataset_id=bundle.DATASET_ID,
                asset_ids=[bundle.ASSET_A],
                benchmark_id=bundle.BENCH_SPY,
                time_policy="observed_content",
                **window,
            )
            self.assertEqual(record["skipped_sources"], {"future_x": 1})
            self.assertEqual(record["package_version"], research_datasets.__version__)


if __name__ == "__main__":
    unittest.main()
