"""Tests for typed SEC filing events, earnings announcement timing, EAR, SUE, and holiday clocks."""

from __future__ import annotations

import tempfile
import unittest
from datetime import date, time
from typing import Any

import numpy as np
import pandas as pd
from pandas.testing import assert_frame_equal

import research_datasets
from research_datasets import (
    DEFAULT_SEC_EVENT_VOCABULARY,
    Calendar,
    classify_sec_filing,
    earnings_calendar_asof,
    earnings_features,
    fiscal_quarters,
    is_sec_business_day,
    label_announcement_flags,
    next_sec_business_day,
    nyse_early_closes,
    nyse_holidays,
    sec_event_specs,
    sec_public_clock,
    sec_public_fallback,
    sue_features,
    typed_event_features,
    us_federal_holidays,
)
from research_datasets.clocks import GRACE_NS, instants, wall_instants
from tests import test_sdk as bundle

ASSET_1 = "00000000-0000-4000-8000-000000000101"
ASSET_2 = "00000000-0000-4000-8000-000000000102"
BENCH = "00000000-0000-4000-8000-000000000199"
CIK_1 = "0000000201"
CIK_2 = "0000000202"


def _make_fact(
    fact_id: str,
    cik: str,
    tag: str,
    value: float,
    period_start: str,
    period_end: str,
    *,
    unit: str = "USD/shares",
    form: str = "10-Q",
    period_kind: str = "quarter",
    accession: str,
    public_at: str,
    filed: str | None = None,
) -> dict[str, Any]:
    pub_day = filed or public_at[:10]
    return {
        "fact_id": fact_id,
        "cik": cik,
        "metric": tag,
        "source": "sec",
        "taxonomy": "us-gaap",
        "tag": tag,
        "tag_priority": 1,
        "unit": unit,
        "currency": "USD",
        "value": f"{value:.6f}",
        "period_start": period_start,
        "period_end": period_end,
        "period_kind": period_kind,
        "form": form,
        "accession": accession,
        "filed": pub_day,
        "public_at": public_at,
        "public_date": pub_day,
        "public_time_precision": "second",
        "observed_at": public_at,
        "content_first_seen_at": public_at,
        "observation_sequence": 1,
        "is_retracted": False,
    }


def _sample_rows(
    cal: Calendar,
    asset_ids: list[str],
    session_indices: list[int],
    *,
    coverage: str | dict[tuple[str, int], str] = "checked",
) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for aid in asset_ids:
        for idx in session_indices:
            cov = (
                coverage.get((aid, idx), "checked")
                if isinstance(coverage, dict)
                else coverage
            )
            dec_ns = int(cal.decisions[idx + 1])
            rows.append(
                {
                    "asset_id": aid,
                    "signal_session": cal.days[idx],
                    "decision_at": pd.Timestamp(dec_ns, tz="UTC"),
                    "sec_history_coverage": cov,
                }
            )
    return pd.DataFrame(rows)


class ClocksAndSecVocabularyTest(unittest.TestCase):
    def test_sec_public_clock_is_idempotent_on_projected_and_old_rows(self) -> None:
        # Intraday filing accepted 16:05 ET (21:05Z) on 2026-01-25 -> stays 21:05Z
        ts_intra = sec_public_clock("2026-01-25T21:05:00Z", "2026-01-25")
        self.assertEqual(ts_intra, pd.Timestamp("2026-01-25T21:05:00Z"))
        self.assertEqual(sec_public_clock(ts_intra, "2026-01-25"), ts_intra)

        # After-17:30 ET filing accepted 22:45Z on 2026-01-22 with SEC filing_date 2026-01-23
        # -> 06:00 ET on 2026-01-23 (11:00Z), and re-applying is a fixed point.
        ts_late = sec_public_clock("2026-01-22T22:45:00Z", "2026-01-23")
        self.assertEqual(ts_late, pd.Timestamp("2026-01-23T11:00:00Z"))
        self.assertEqual(sec_public_clock(ts_late, "2026-01-23"), ts_late)
        self.assertEqual(
            sec_public_clock(ts_late.isoformat(), date(2026, 1, 23)), ts_late
        )

        # Schedule 13D / Section 16 same-day exception (accepted 21:15 ET, same filing date)
        ts_same_day = sec_public_clock("2026-01-23T02:15:00Z", "2026-01-22")
        self.assertEqual(ts_same_day, pd.Timestamp("2026-01-23T02:15:00Z"))
        self.assertEqual(sec_public_clock(ts_same_day, "2026-01-22"), ts_same_day)

        # Missing acceptance stays None
        self.assertIsNone(sec_public_clock("", "2026-01-23"))
        self.assertIsNone(sec_public_clock(None, "2026-01-23"))

    def test_clocks_holiday_and_early_close_fallback(self) -> None:
        fed_2025 = us_federal_holidays(2025)
        nyse_2025 = nyse_holidays(2025)
        # Columbus Day (2025-10-13) and Veterans Day (2025-11-11): SEC closed, NYSE open
        self.assertIn(date(2025, 10, 13), fed_2025)
        self.assertNotIn(date(2025, 10, 13), nyse_2025)
        self.assertIn(date(2025, 11, 11), fed_2025)
        self.assertNotIn(date(2025, 11, 11), nyse_2025)
        self.assertFalse(is_sec_business_day(date(2025, 10, 13)))
        self.assertEqual(next_sec_business_day(date(2025, 10, 10)), date(2025, 10, 14))

        # Good Friday (2025-04-18): NYSE closed, federal government open
        self.assertIn(date(2025, 4, 18), nyse_2025)
        self.assertNotIn(date(2025, 4, 18), fed_2025)

        # Friday 2025-10-10 17:45 ET (21:45Z) without filing_date -> Tuesday 2025-10-14 06:00 ET (10:00Z)
        fallback_ts = sec_public_fallback("2025-10-10T21:45:00Z", None)
        self.assertEqual(fallback_ts, pd.Timestamp("2025-10-14T10:00:00Z"))
        self.assertEqual(
            sec_public_clock("2025-10-10T21:45:00Z", None, holiday_fallback=True),
            pd.Timestamp("2025-10-14T10:00:00Z"),
        )

        # NYSE early closes: July 3, Friday after Thanksgiving, Dec 24
        early_2025 = nyse_early_closes(
            [
                "2025-07-02",
                "2025-07-03",
                "2025-11-26",
                "2025-11-28",
                "2025-12-24",
                "2025-12-26",
            ]
        )
        self.assertEqual(early_2025.get("2025-07-03"), "13:00")
        self.assertEqual(early_2025.get("2025-11-28"), "13:00")
        self.assertEqual(early_2025.get("2025-12-24"), "13:00")
        self.assertNotIn("2025-07-02", early_2025)

        cal = Calendar(
            ["2025-11-26", "2025-11-28", "2025-12-01"],
            infer_early_closes=True,
        )
        # 2025-11-28 13:00 EST == 18:00Z
        self.assertEqual(
            pd.Timestamp(int(cal.closes[1]), tz="UTC"),
            pd.Timestamp("2025-11-28T18:00:00Z"),
        )
        # Regular session 2025-11-26 16:00 EST == 21:00Z
        self.assertEqual(
            pd.Timestamp(int(cal.closes[0]), tz="UTC"),
            pd.Timestamp("2025-11-26T21:00:00Z"),
        )

    def test_8k_amendment_maps_only_to_amendment_and_forms_classify(self) -> None:
        self.assertEqual(
            classify_sec_filing("8-K/A", "2.02, 9.01"),
            ["current_report_amendment"],
        )
        self.assertEqual(
            classify_sec_filing("8-K", " 2.02 , 5.02 , 9.01 , 99.99 "),
            ["results_release", "officer_director_change"],
        )
        self.assertEqual(classify_sec_filing("SC 13D"), ["activist_stake"])
        self.assertEqual(
            classify_sec_filing("SCHEDULE 13D/A"), ["activist_stake_amendment"]
        )
        self.assertEqual(classify_sec_filing("NT 10-Q"), ["late_filing_notice"])
        self.assertEqual(classify_sec_filing("25-NSE"), ["exchange_delisting_notice"])
        self.assertEqual(classify_sec_filing("15F-12G"), ["registration_termination"])
        self.assertEqual(classify_sec_filing("424B2"), [])
        self.assertEqual(classify_sec_filing("SC 13G"), [])

        specs = sec_event_specs({"sec_event_kinds": dict(DEFAULT_SEC_EVENT_VOCABULARY)})
        names = [s.name for s in specs]
        self.assertIn("sec_kind_results_release", names)
        self.assertIn("sec_kind_current_report_amendment", names)
        self.assertIn("sec_kind_activist_stake_amendment", names)
        self.assertEqual(sec_event_specs({}), ())


class TypedEventFeaturesTest(unittest.TestCase):
    def setUp(self) -> None:
        days = pd.bdate_range("2025-01-02", periods=130).date.tolist()
        self.cal = Calendar(days)

    def test_cutoff_is_inclusive_for_0600_public_times(self) -> None:
        # Signal session index 10 -> entry session index 11 -> decision_at = 06:00 ET on days[11]
        entry_day = self.cal.days[11].isoformat()
        dec_ts = pd.Timestamp(int(self.cal.decisions[11]), tz="UTC")
        after_ts = dec_ts + pd.Timedelta(seconds=1)
        obs = pd.DataFrame(
            [
                {
                    "source": "sec",
                    "event_uid": "sec:1:exact",
                    "observation_sequence": 1,
                    "form": "8-K",
                    "items": "2.02",
                    "filing_date": entry_day,
                    "asset_ids": [ASSET_1],
                    "public_at": dec_ts.isoformat().replace("+00:00", "Z"),
                    "public_time_precision": "second",
                    "content_first_seen_at": dec_ts.isoformat().replace("+00:00", "Z"),
                    "observation_recorded_at": dec_ts.isoformat().replace(
                        "+00:00", "Z"
                    ),
                },
                {
                    "source": "sec",
                    "event_uid": "sec:1:after",
                    "observation_sequence": 1,
                    "form": "8-K",
                    "items": "5.02",
                    "filing_date": entry_day,
                    "asset_ids": [ASSET_1],
                    "public_at": after_ts.isoformat().replace("+00:00", "Z"),
                    "public_time_precision": "second",
                    "content_first_seen_at": after_ts.isoformat().replace(
                        "+00:00", "Z"
                    ),
                    "observation_recorded_at": after_ts.isoformat().replace(
                        "+00:00", "Z"
                    ),
                },
            ]
        )
        samples = _sample_rows(self.cal, [ASSET_1], [10, 11])
        out = typed_event_features(
            obs,
            samples,
            kinds=["results_release", "officer_director_change"],
            calendar=self.cal,
            windows=(5,),
        )
        # At signal 10 (decision = 06:00 ET on day 11): exact 06:00 is INCLUDED, +1s is EXCLUDED
        self.assertEqual(out.loc[0, "sec_kind_results_release_count_5s"], 1.0)
        self.assertAlmostEqual(out.loc[0, "sec_kind_results_release_days_since"], 0.0)
        self.assertEqual(out.loc[0, "sec_kind_officer_director_change_count_5s"], 0.0)
        self.assertTrue(
            pd.isna(out.loc[0, "sec_kind_officer_director_change_days_since"])
        )
        # At signal 11 (next session): +1s event is now visible
        self.assertEqual(out.loc[1, "sec_kind_officer_director_change_count_5s"], 1.0)

    def test_typed_counts_windows_days_since_and_coverage_mask(self) -> None:
        t_ev = (
            pd.Timestamp(int(self.cal.decisions[65]), tz="UTC")
            .isoformat()
            .replace("+00:00", "Z")
        )
        obs = pd.DataFrame(
            [
                {
                    "source": "sec",
                    "event_uid": "sec:1:nt",
                    "observation_sequence": 1,
                    "form": "NT 10-Q",
                    "items": "",
                    "filing_date": self.cal.days[65].isoformat(),
                    "asset_ids": [ASSET_1],
                    "event_kinds": ["late_filing_notice"],
                    "public_at": t_ev,
                    "public_time_precision": "second",
                }
            ]
        )
        cov_map = {
            (ASSET_1, 20): "checked",
            (ASSET_1, 70): "checked",
            (ASSET_1, 75): "partial",
            (ASSET_1, 115): "checked",
        }
        samples = _sample_rows(self.cal, [ASSET_1], [20, 70, 75, 115], coverage=cov_map)
        out = typed_event_features(
            obs,
            samples,
            kinds=["late_filing_notice"],
            calendar=self.cal,
            windows=(10, 63),
            days_cap=30,
        )
        # Row 0 (signal 20 < 62): 10s window is complete (0.0), 63s window lacks warm-up (NaN)
        self.assertEqual(out.loc[0, "sec_kind_late_filing_notice_count_10s"], 0.0)
        self.assertTrue(pd.isna(out.loc[0, "sec_kind_late_filing_notice_count_63s"]))

        # Row 1 (signal 70, decision 71): inside 10s and 63s windows, < 30 days since
        self.assertEqual(out.loc[1, "sec_kind_late_filing_notice_count_10s"], 1.0)
        self.assertEqual(out.loc[1, "sec_kind_late_filing_notice_count_63s"], 1.0)
        self.assertGreater(out.loc[1, "sec_kind_late_filing_notice_days_since"], 0.0)

        # Row 2 (signal 75, coverage="partial"): masked to NaN, never 0
        self.assertTrue(pd.isna(out.loc[2, "sec_kind_late_filing_notice_count_10s"]))
        self.assertTrue(pd.isna(out.loc[2, "sec_kind_late_filing_notice_count_63s"]))
        self.assertTrue(pd.isna(out.loc[2, "sec_kind_late_filing_notice_days_since"]))

        # Row 3 (signal 115): outside 10s window (0.0), inside 63s window (1.0), beyond 30-day cap (NaN)
        self.assertEqual(out.loc[3, "sec_kind_late_filing_notice_count_10s"], 0.0)
        self.assertEqual(out.loc[3, "sec_kind_late_filing_notice_count_63s"], 1.0)
        self.assertTrue(pd.isna(out.loc[3, "sec_kind_late_filing_notice_days_since"]))

    def test_bulk_kind_is_flagged_and_masked(self) -> None:
        rows = []
        for idx in range(25):
            ts = (
                pd.Timestamp(int(self.cal.decisions[idx + 5]), tz="UTC")
                .isoformat()
                .replace("+00:00", "Z")
            )
            rows.append(
                {
                    "source": "sec",
                    "event_uid": f"sec:1:424b5:{idx}",
                    "observation_sequence": 1,
                    "form": "424B5",
                    "items": "",
                    "filing_date": self.cal.days[idx + 5].isoformat(),
                    "asset_ids": [ASSET_1],
                    "public_at": ts,
                    "public_time_precision": "second",
                }
            )
        obs = pd.DataFrame(rows)
        samples = _sample_rows(
            self.cal,
            [ASSET_1, ASSET_2],
            [70],
            coverage={(ASSET_1, 70): "checked", (ASSET_2, 70): "mapping_missing"},
        )
        out = typed_event_features(
            obs,
            samples,
            kinds=["prospectus_supplement"],
            calendar=self.cal,
            windows=(63,),
            bulk_threshold=24,
        )
        self.assertEqual(bool(out.loc[0, "sec_kind_prospectus_supplement_bulk"]), True)
        self.assertTrue(pd.isna(out.loc[0, "sec_kind_prospectus_supplement_count_63s"]))
        # Uncountable coverage masks bulk boolean to NA as well
        self.assertTrue(pd.isna(out.loc[1, "sec_kind_prospectus_supplement_bulk"]))


class EarningsAndSueFeaturesTest(unittest.TestCase):
    def setUp(self) -> None:
        days = pd.bdate_range("2024-01-02", "2026-06-30").date.tolist()
        self.cal = Calendar(days)

    def _flat_prices(
        self,
        assets: list[str],
        *,
        overrides: dict[tuple[str, date], float] | None = None,
    ) -> pd.DataFrame:
        overrides = overrides or {}
        rows = []
        for aid in assets:
            for d in self.cal.days:
                px = overrides.get((aid, d), 100.0)
                rows.append(
                    {
                        "asset_id": aid,
                        "date": d,
                        "open": px,
                        "close": px,
                        "volume": 1_000_000.0,
                    }
                )
        return pd.DataFrame(rows)

    def test_asof_primary_switches_only_after_reaction_known(self) -> None:
        # Preliminary 8-K on day 40 pre-open (08:00 ET), r0 = day 40, reaction_known_at = close of day 41
        d_prelim = self.cal.days[40]
        rk_prelim = (
            pd.Timestamp(int(self.cal.closes[41]), tz="UTC")
            .isoformat()
            .replace("+00:00", "Z")
        )
        # Full release 8-K on day 50 pre-open (08:00 ET), r0 = day 50, reaction_known_at = close of day 51
        d_full = self.cal.days[50]
        rk_full = (
            pd.Timestamp(int(self.cal.closes[51]), tz="UTC")
            .isoformat()
            .replace("+00:00", "Z")
        )

        # Give prelim a +2% abnormal return and full release a +8% abnormal return
        overrides = {
            (ASSET_1, self.cal.days[41]): 102.0,
            (ASSET_1, self.cal.days[51]): 108.0,
        }
        adj = self._flat_prices([ASSET_1, BENCH], overrides=overrides)

        ann = pd.DataFrame(
            [
                {
                    "announcement_id": f"{CIK_1}:prelim",
                    "asset_id": ASSET_1,
                    "cik": CIK_1,
                    "kind": "8k_item_2_02",
                    "role": "results_candidate",
                    "filing_date": d_prelim.isoformat(),
                    "public_at": f"{d_prelim.isoformat()}T13:00:00Z",
                    "observed_available_at": f"{d_prelim.isoformat()}T13:00:00Z",
                    "period_end_estimated": "2023-12-31",
                    "reaction_session_initial": d_prelim.isoformat(),
                    "reaction_session": d_prelim.isoformat(),
                    "volume_ratio_reaction": 1.8,
                    "reaction_known_at": rk_prelim,
                    "is_primary_final": False,  # ex-post says full won — feature MUST ignore this!
                },
                {
                    "announcement_id": f"{CIK_1}:full",
                    "asset_id": ASSET_1,
                    "cik": CIK_1,
                    "kind": "8k_item_2_02",
                    "role": "results_candidate",
                    "filing_date": d_full.isoformat(),
                    "public_at": f"{d_full.isoformat()}T12:30:00Z",
                    "observed_available_at": f"{d_full.isoformat()}T12:30:00Z",
                    "period_end_estimated": "2023-12-31",
                    "reaction_session_initial": d_full.isoformat(),
                    "reaction_session": d_full.isoformat(),
                    "volume_ratio_reaction": 4.5,
                    "reaction_known_at": rk_full,
                    "is_primary_final": True,
                },
            ]
        )

        # Sample at:
        # 1) signal 40 (decision = 06:00 ET on day 41): prelim public, prelim rk NOT yet known
        # 2) signal 42 (decision = 06:00 ET on day 43): prelim rk known, full NOT yet public
        # 3) signal 50 (decision = 06:00 ET on day 51): full IS public, full rk NOT yet known!
        # 4) signal 51 (decision = 06:00 ET on day 52 > close of day 51): full rk IS known!
        samples = _sample_rows(self.cal, [ASSET_1], [40, 42, 50, 51])
        out = earnings_features(
            ann,
            samples,
            calendar=self.cal,
            adjusted=adj,
            benchmark_id=BENCH,
            horizons=(5, 21),
        )

        # 1) Prelim public, reaction pending
        self.assertEqual(out.loc[0, "earn_candidates_in_period"], 1.0)
        self.assertTrue(pd.isna(out.loc[0, "earn_volume_ratio"]))
        self.assertTrue(pd.isna(out.loc[0, "earn_ear"]))
        self.assertEqual(bool(out.loc[0, "earn_ear_pending"]), True)

        # 2) Prelim reaction known
        self.assertEqual(out.loc[1, "earn_candidates_in_period"], 1.0)
        self.assertAlmostEqual(out.loc[1, "earn_volume_ratio"], 1.8)
        self.assertAlmostEqual(out.loc[1, "earn_ear"], 0.02, places=6)
        self.assertEqual(bool(out.loc[1, "earn_ear_pending"]), False)

        # 3) Full release is public (cands=2), BUT full.reaction_known_at > decision_at:
        #    primary MUST stay prelim (ratio 1.8, days_since from prelim, EAR +2%)!
        self.assertEqual(out.loc[2, "earn_candidates_in_period"], 2.0)
        self.assertAlmostEqual(out.loc[2, "earn_volume_ratio"], 1.8)
        self.assertAlmostEqual(out.loc[2, "earn_ear"], 0.02, places=6)
        self.assertEqual(
            out.loc[2, "earn_days_since"],
            float((self.cal.days[51] - d_prelim).days),
        )

        # 4) After full.reaction_known_at: primary switches to full release (ratio 4.5, EAR +8%)!
        self.assertEqual(out.loc[3, "earn_candidates_in_period"], 2.0)
        self.assertAlmostEqual(out.loc[3, "earn_volume_ratio"], 4.5)
        self.assertAlmostEqual(out.loc[3, "earn_ear"], 0.08, places=6)
        self.assertEqual(
            out.loc[3, "earn_days_since"],
            float((self.cal.days[52] - d_full).days),
        )

    def test_ear_known_only_after_reaction_window_and_prefers_total_return(
        self,
    ) -> None:
        r_day = self.cal.days[30]
        rk_ts = (
            pd.Timestamp(int(self.cal.closes[31]), tz="UTC")
            .isoformat()
            .replace("+00:00", "Z")
        )
        adj = self._flat_prices(
            [ASSET_1, BENCH], overrides={(ASSET_1, self.cal.days[31]): 105.0}
        )
        # daily_returns has total-return index (+7% instead of vendor +5%)
        dr_rows = []
        for aid in (ASSET_1, BENCH):
            for idx, d in enumerate(self.cal.days[:40]):
                tr = 1.07 if (aid == ASSET_1 and idx == 31) else 1.0
                dr_rows.append(
                    {
                        "asset_id": aid,
                        "date": d.isoformat(),
                        "row_kind": "session",
                        "tr_index": tr,
                    }
                )
        dr_df = pd.DataFrame(dr_rows)
        ann = pd.DataFrame(
            [
                {
                    "announcement_id": f"{CIK_1}:q1",
                    "asset_id": ASSET_1,
                    "kind": "8k_item_2_02",
                    "role": "results_candidate",
                    "filing_date": r_day.isoformat(),
                    "public_at": f"{r_day.isoformat()}T12:00:00Z",
                    "period_end_estimated": "2023-12-31",
                    "reaction_session_initial": r_day.isoformat(),
                    "reaction_session": r_day.isoformat(),
                    "volume_ratio_reaction": 2.4,
                    "reaction_known_at": rk_ts,
                }
            ]
        )
        samples = _sample_rows(self.cal, [ASSET_1], [30, 31])
        out = earnings_features(
            ann,
            samples,
            calendar=self.cal,
            adjusted=adj,
            daily_returns=dr_df,
            benchmark_id=BENCH,
        )
        # Signal 30 -> decision 06:00 ET on day 31 (before day 31 close): EAR unknown
        self.assertTrue(pd.isna(out.loc[0, "earn_ear"]))
        self.assertEqual(bool(out.loc[0, "earn_ear_pending"]), True)
        # Signal 31 -> decision 06:00 ET on day 32 (after day 31 close): EAR uses tr_index (+7%)
        self.assertAlmostEqual(out.loc[1, "earn_ear"], 0.07, places=6)
        self.assertEqual(bool(out.loc[1, "earn_ear_pending"]), False)

    def test_next_announcement_estimate_uses_prior_year_lag_and_calendar_when_linked(
        self,
    ) -> None:
        # Four historical quarters in 2024 + Q1 2025 so Q2 2025 prior-year lag uses Q2 2024's exact lag!
        # Q2 2024 period_end = 2024-06-30, announced 2024-07-30 (lag = 30 days)
        # Other quarters use lag = 45 days so prior-year same-quarter lag (30d) is distinct from median (45d)!
        quarters = [
            ("2024-03-31", "2024-05-15", 2.0),
            ("2024-06-30", "2024-07-30", 2.1),
            ("2024-09-30", "2024-11-14", 2.2),
            ("2024-12-31", "2025-02-14", 2.3),
            ("2025-03-31", "2025-05-15", 2.4),
        ]
        ann_rows = []
        for idx, (pe, pub_d, vr) in enumerate(quarters):
            # Pick nearest calendar session for reaction
            pub_date = date.fromisoformat(pub_d)
            r_pos = int(np.searchsorted(self.cal.days, pub_date, "left"))
            rk = (
                pd.Timestamp(int(self.cal.closes[r_pos + 1]), tz="UTC")
                .isoformat()
                .replace("+00:00", "Z")
            )
            ann_rows.append(
                {
                    "announcement_id": f"{CIK_1}:q{idx}",
                    "asset_id": ASSET_1,
                    "kind": "8k_item_2_02",
                    "role": "results_candidate",
                    "filing_date": pub_d,
                    "public_at": f"{pub_d}T12:00:00Z",
                    "period_end_estimated": pe,
                    "reaction_session_initial": self.cal.days[r_pos].isoformat(),
                    "reaction_session": self.cal.days[r_pos].isoformat(),
                    "volume_ratio_reaction": vr,
                    "reaction_known_at": rk,
                }
            )
        ann = pd.DataFrame(ann_rows)
        adj = self._flat_prices([ASSET_1, BENCH])

        # Sample around 2025-07-10
        sig_idx = int(np.searchsorted(self.cal.days, date(2025, 7, 10), "left"))
        samples = _sample_rows(self.cal, [ASSET_1], [sig_idx])
        dec_day = self.cal.days[sig_idx + 1]

        # 1) Without Finnhub calendar: next period = 2025-06-30 + 30d (Q2 2024 lag) = 2025-07-30
        out_lag = earnings_features(
            ann,
            samples,
            calendar=self.cal,
            adjusted=adj,
            benchmark_id=BENCH,
            horizons=(5, 21),
        )
        expected_lag_days = (date(2025, 7, 30) - dec_day).days
        self.assertEqual(str(out_lag.loc[0, "earn_next_basis"]), "prior_year_lag")
        self.assertAlmostEqual(
            out_lag.loc[0, "earn_days_until_next_est"], float(expected_lag_days)
        )
        self.assertEqual(bool(out_lag.loc[0, "earn_next_within_5s"]), False)
        self.assertEqual(bool(out_lag.loc[0, "earn_next_within_21s"]), True)

        # 2) With linked Finnhub calendar row for 2025Q2 on 2025-07-24 observed before decision_at
        ev_obs = pd.DataFrame(
            [
                {
                    "source": "finnhub_earnings",
                    "event_uid": "finnhub_earnings:aapl:2025q2",
                    "observation_sequence": 1,
                    "asset_ids": [ASSET_1],
                    "observation_recorded_at": "2025-07-01T12:00:00Z",
                }
            ]
        )
        earn_obs = pd.DataFrame(
            [
                {
                    "event_uid": "finnhub_earnings:aapl:2025q2",
                    "asset_id": ASSET_1,
                    "symbol": "AAPL",
                    "event_date": "2025-07-24",
                    "fiscal_year": 2025,
                    "fiscal_quarter": 2,
                    "hour": "amc",
                    "observed_at": "2025-07-01T12:00:00Z",
                    "observation_sequence": 1,
                }
            ]
        )
        out_cal = earnings_features(
            ann,
            samples,
            calendar=self.cal,
            adjusted=adj,
            benchmark_id=BENCH,
            event_observations=ev_obs,
            earnings_observations=earn_obs,
            horizons=(5, 21),
        )
        self.assertEqual(str(out_cal.loc[0, "earn_next_basis"]), "finnhub_calendar")
        self.assertAlmostEqual(
            out_cal.loc[0, "earn_days_until_next_est"],
            float((date(2025, 7, 24) - dec_day).days),
        )

    def test_sue_uses_same_filing_comparative_and_price_scaling_across_split(
        self,
    ) -> None:
        # Build 10 quarters (2023Q1..2025Q2) of 3-month reported EPS facts with same-filing
        # prior-year comparatives for two parallel issuers:
        #   CIK_1 / ASSET_1: unsplit reference, raw close = $100 throughout.
        #   CIK_2 / ASSET_2: 2:1 forward stock split on 2024-09-01!
        #     - Filings before 2024-09-01 report pre-split EPS and pre-split comparative (raw close $100).
        #     - Filings after 2024-09-01 report post-split EPS (x 0.5) AND post-split prior-year
        #       comparative (x 0.5) in the same filing, with post-split raw close $50!
        all_days = pd.bdate_range("2022-01-03", "2025-12-31").date.tolist()
        cal = Calendar(all_days)
        split_date = date(2024, 9, 1)

        # True pre-split quarterly EPS for 2022Q1..2025Q2 (14 quarters -> 10 YoY deltas -> >= 8 prior deltas!)
        q_specs = [
            # (year, q, p_start, p_end, filed_date, pre_split_eps, pre_split_rev)
            (2022, 1, "2022-01-01", "2022-03-31", "2022-05-05", 1.00, 1000.0),
            (2022, 2, "2022-04-01", "2022-06-30", "2022-08-05", 1.10, 1050.0),
            (2022, 3, "2022-07-01", "2022-09-30", "2022-11-04", 1.20, 1100.0),
            (2022, 4, "2022-10-01", "2022-12-31", "2023-02-10", 1.30, 1200.0),
            (2023, 1, "2023-01-01", "2023-03-31", "2023-05-05", 1.12, 1080.0),
            (2023, 2, "2023-04-01", "2023-06-30", "2023-08-04", 1.28, 1150.0),
            (2023, 3, "2023-07-01", "2023-09-30", "2023-11-03", 1.35, 1210.0),
            (2023, 4, "2023-10-01", "2023-12-31", "2024-02-09", 1.52, 1340.0),
            (2024, 1, "2024-01-01", "2024-03-31", "2024-05-06", 1.26, 1190.0),
            (2024, 2, "2024-04-01", "2024-06-30", "2024-08-05", 1.49, 1290.0),
            # Split happens 2024-09-01 before 2024Q3 filing!
            (2024, 3, "2024-07-01", "2024-09-30", "2024-11-05", 1.61, 1360.0),
            (2024, 4, "2024-10-01", "2024-12-31", "2025-02-11", 1.80, 1500.0),
            (2025, 1, "2025-01-01", "2025-03-31", "2025-05-06", 1.58, 1330.0),
            (2025, 2, "2025-04-01", "2025-06-30", "2025-08-05", 1.85, 1460.0),
        ]
        by_yq = {
            (y, q): (ps, pe, fd, eps, rev) for y, q, ps, pe, fd, eps, rev in q_specs
        }

        facts: list[dict[str, Any]] = []
        for y, q, ps, pe, fd, eps, rev in q_specs:
            filed_dt = date.fromisoformat(fd)
            pub_at = f"{fd}T20:30:00Z"  # 16:30 ET after market close
            for cik, is_split in ((CIK_1, False), (CIK_2, True)):
                scale = 0.5 if (is_split and filed_dt >= split_date) else 1.0
                acc = f"{cik}-{y}Q{q}"
                facts.append(
                    _make_fact(
                        f"{acc}:eps:cur",
                        cik,
                        "EarningsPerShareDiluted",
                        eps * scale,
                        ps,
                        pe,
                        accession=acc,
                        public_at=pub_at,
                    )
                )
                facts.append(
                    _make_fact(
                        f"{acc}:rev:cur",
                        cik,
                        "Revenues",
                        rev,
                        ps,
                        pe,
                        unit="USD",
                        accession=acc,
                        public_at=pub_at,
                    )
                )
                if (y - 1, q) in by_yq:
                    pps, ppe, _, peps, prev_rev = by_yq[(y - 1, q)]
                    # Same-filing comparative uses THIS filing's split basis (`scale`)!
                    facts.append(
                        _make_fact(
                            f"{acc}:eps:cmp",
                            cik,
                            "EarningsPerShareDiluted",
                            peps * scale,
                            pps,
                            ppe,
                            accession=acc,
                            public_at=pub_at,
                        )
                    )
                    facts.append(
                        _make_fact(
                            f"{acc}:rev:cmp",
                            cik,
                            "Revenues",
                            prev_rev,
                            pps,
                            ppe,
                            unit="USD",
                            accession=acc,
                            public_at=pub_at,
                        )
                    )

        material = {
            "manifest": {"source_timezones": {"sec": "America/New_York"}},
            "universe": pd.DataFrame(
                [
                    {
                        "asset_id": ASSET_1,
                        "cik": CIK_1,
                        "issuer_mapping_status": "verified",
                    },
                    {
                        "asset_id": ASSET_2,
                        "cik": CIK_2,
                        "issuer_mapping_status": "verified",
                    },
                ]
            ),
            "fundamentals": pd.DataFrame(facts),
        }
        q_ledger = fiscal_quarters(
            material,
            time_policy="public_reconstructed",
            concepts=("eps_diluted", "revenue"),
        )

        # Raw closes: ASSET_1 stays $100; ASSET_2 is $100 before split_date and $50 on/after split_date
        raw_rows = []
        for d in all_days:
            raw_rows.append({"asset_id": ASSET_1, "date": d, "close": 100.0})
            raw_rows.append(
                {
                    "asset_id": ASSET_2,
                    "date": d,
                    "close": 50.0 if d >= split_date else 100.0,
                }
            )
        raw_df = pd.DataFrame(raw_rows)

        # Evaluate post-split decisions after 2024Q3, 2024Q4, 2025Q1, and 2025Q2 filings
        eval_dates = [
            date(2024, 11, 8),
            date(2025, 2, 14),
            date(2025, 5, 9),
            date(2025, 8, 8),
        ]
        eval_indices = [int(np.searchsorted(cal.days, d, "left")) for d in eval_dates]
        samples_u = _sample_rows(cal, [ASSET_1], eval_indices)
        samples_s = _sample_rows(cal, [ASSET_2], eval_indices)

        sue_u = sue_features(
            q_ledger,
            samples_u,
            raw=raw_df,
            asset_ciks={ASSET_1: CIK_1},
        )
        sue_s = sue_features(
            q_ledger,
            samples_s,
            raw=raw_df,
            asset_ciks={ASSET_2: CIK_2},
        )

        self.assertTrue(sue_s["earn_sue_eps"].notna().all())
        self.assertTrue(sue_s["earn_sue_eps_price"].notna().all())
        self.assertTrue(sue_s["earn_sue_revenue"].notna().all())
        np.testing.assert_allclose(
            sue_s["earn_sue_eps_price"].to_numpy(dtype=float),
            sue_u["earn_sue_eps_price"].to_numpy(dtype=float),
            rtol=1e-12,
            atol=1e-12,
        )
        np.testing.assert_allclose(
            sue_s["earn_sue_eps"].to_numpy(dtype=float),
            sue_u["earn_sue_eps"].to_numpy(dtype=float),
            rtol=1e-12,
            atol=1e-12,
        )
        np.testing.assert_allclose(
            sue_s["earn_sue_revenue"].to_numpy(dtype=float),
            sue_u["earn_sue_revenue"].to_numpy(dtype=float),
            rtol=1e-12,
            atol=1e-12,
        )

    def test_sue_q4_is_flagged_approximate_and_stale_after_8k(self) -> None:
        q_ledger = pd.DataFrame(
            [
                {
                    "cik": CIK_1,
                    "concept": "eps_diluted",
                    "period_end": date(2024, 12, 31),
                    "value_first": 1.40,
                    "prior_year_value_first": 1.15,
                    "basis_first": "fy_minus_ytd_approx",
                    "status_first": "approximate",
                    "available_at_first": pd.Timestamp("2025-02-15T12:00:00Z"),
                },
                {
                    "cik": CIK_1,
                    "concept": "revenue",
                    "period_end": date(2024, 12, 31),
                    "value_first": 2500.0,
                    "prior_year_value_first": 2200.0,
                    "basis_first": "fy_minus_ytd",
                    "status_first": "ok",
                    "available_at_first": pd.Timestamp("2025-02-15T12:00:00Z"),
                },
            ]
        )
        raw_df = pd.DataFrame(
            [{"asset_id": ASSET_1, "date": d, "close": 100.0} for d in self.cal.days]
        )
        idx_before_8k = int(np.searchsorted(self.cal.days, date(2025, 3, 10), "left"))
        idx_after_8k = int(np.searchsorted(self.cal.days, date(2025, 4, 25), "left"))
        samples = _sample_rows(self.cal, [ASSET_1], [idx_before_8k, idx_after_8k])
        out = sue_features(
            q_ledger,
            samples,
            raw=raw_df,
            asset_ciks={ASSET_1: CIK_1},
            primary_period_end=["2024-12-31", "2025-03-31"],
        )
        self.assertEqual(str(out.loc[0, "earn_sue_basis"]), "fy_minus_ytd_approx")
        self.assertEqual(bool(out.loc[0, "earn_sue_approximate"]), True)
        self.assertEqual(bool(out.loc[0, "earn_sue_stale"]), False)
        # Once 2025Q1 8-K arrives while XBRL is still on 2024Q4, earn_sue_stale flips True!
        self.assertEqual(bool(out.loc[1, "earn_sue_stale"]), True)

    def test_earnings_calendar_asof_respects_removals_and_observed_clock(self) -> None:
        ev_obs = pd.DataFrame(
            [
                {
                    "source": "finnhub_earnings",
                    "event_uid": "finnhub_earnings:1",
                    "observation_sequence": 1,
                    "asset_ids": [ASSET_1, ASSET_2],
                    "observation_recorded_at": "2025-04-01T10:00:00Z",
                },
                # At 2025-04-10, identity relink removes ASSET_2 from this event!
                {
                    "source": "finnhub_earnings",
                    "event_uid": "finnhub_earnings:1",
                    "observation_sequence": 2,
                    "asset_ids": [ASSET_1],
                    "observation_recorded_at": "2025-04-10T10:00:00Z",
                },
            ]
        )
        earn_obs = pd.DataFrame(
            [
                {
                    "event_uid": "finnhub_earnings:1",
                    "asset_id": ASSET_1,
                    "symbol": "AAPL",
                    "event_date": "2025-04-28",
                    "fiscal_year": 2025,
                    "fiscal_quarter": 2,
                    "eps_estimate": 1.50,
                    "observed_at": "2025-04-01T10:00:00Z",
                    "observation_sequence": 1,
                },
                {
                    "event_uid": "finnhub_earnings:1",
                    "asset_id": ASSET_2,
                    "symbol": "AAPL_OLD",
                    "event_date": "2025-04-28",
                    "fiscal_year": 2025,
                    "fiscal_quarter": 2,
                    "eps_estimate": 1.50,
                    "observed_at": "2025-04-01T10:00:00Z",
                    "observation_sequence": 1,
                },
                # Later estimate revision at 2025-04-15
                {
                    "event_uid": "finnhub_earnings:1",
                    "asset_id": ASSET_1,
                    "symbol": "AAPL",
                    "event_date": "2025-04-29",
                    "fiscal_year": 2025,
                    "fiscal_quarter": 2,
                    "eps_estimate": 1.55,
                    "observed_at": "2025-04-15T10:00:00Z",
                    "observation_sequence": 2,
                },
            ]
        )

        # Before first capture: empty
        self.assertTrue(
            earnings_calendar_asof(ev_obs, earn_obs, "2025-03-31T23:59:59Z").empty
        )

        # At 2025-04-05: both assets linked, initial estimate 1.50
        t1 = earnings_calendar_asof(ev_obs, earn_obs, "2025-04-05T12:00:00Z")
        self.assertEqual(set(t1["asset_id"]), {ASSET_1, ASSET_2})
        self.assertTrue((t1["eps_estimate"] == 1.50).all())

        # At 2025-04-12: ASSET_2 removed, revision at 04-15 NOT yet observed
        t2 = earnings_calendar_asof(ev_obs, earn_obs, "2025-04-12T12:00:00Z")
        self.assertEqual(t2["asset_id"].tolist(), [ASSET_1])
        self.assertAlmostEqual(t2.loc[0, "eps_estimate"], 1.50)

        t2_all = earnings_calendar_asof(
            ev_obs, earn_obs, "2025-04-12T12:00:00Z", include_unlinked=True
        )
        unlinked = t2_all[t2_all["asset_id"] == ASSET_2]
        self.assertEqual(len(unlinked), 1)
        self.assertEqual(bool(unlinked.iloc[0]["still_linked"]), False)

        # At 2025-04-16: revision 1.55 observed
        t3 = earnings_calendar_asof(ev_obs, earn_obs, "2025-04-16T12:00:00Z")
        self.assertEqual(t3["asset_id"].tolist(), [ASSET_1])
        self.assertAlmostEqual(t3.loc[0, "eps_estimate"], 1.55)
        self.assertEqual(t3.loc[0, "event_date"], "2025-04-29")

    def test_label_flags_are_not_in_feature_output(self) -> None:
        r_day = self.cal.days[20]
        ann = pd.DataFrame(
            [
                {
                    "announcement_id": f"{CIK_1}:1",
                    "asset_id": ASSET_1,
                    "kind": "8k_item_2_02",
                    "role": "results_candidate",
                    "filing_date": r_day.isoformat(),
                    "public_at": f"{r_day.isoformat()}T12:00:00Z",
                    "period_end_estimated": "2023-12-31",
                    "reaction_session_initial": r_day.isoformat(),
                    "reaction_session": r_day.isoformat(),
                    "volume_ratio_reaction": 3.0,
                    "reaction_known_at": pd.Timestamp(
                        int(self.cal.closes[21]), tz="UTC"
                    )
                    .isoformat()
                    .replace("+00:00", "Z"),
                    "is_primary_final": True,
                }
            ]
        )
        adj = self._flat_prices([ASSET_1, BENCH])
        samples = _sample_rows(self.cal, [ASSET_1], [18, 20])
        feat = earnings_features(
            ann,
            samples,
            calendar=self.cal,
            adjusted=adj,
            benchmark_id=BENCH,
            horizons=(5,),
        )
        self.assertFalse(any(col.startswith("label_") for col in feat.columns))

        lflags = label_announcement_flags(
            ann,
            samples[["asset_id", "signal_session"]],
            calendar=self.cal,
            horizons=(5,),
        )
        # Signal 18 window is (18, 23] -> includes session 20 -> True!
        self.assertEqual(bool(lflags.loc[0, "label_has_earnings_5d"]), True)
        self.assertEqual(bool(lflags.loc[0, "label_primary_earnings_5d"]), True)
        # Signal 20 window is (20, 25] -> session 20 is NOT strictly inside (20, 25] -> False!
        self.assertEqual(bool(lflags.loc[1, "label_has_earnings_5d"]), False)


class LookaheadInvarianceAndPanelIntegrationTest(unittest.TestCase):
    def test_features_are_invariant_to_rows_unknown_at_cutoff(self) -> None:
        """Main look-ahead guard: across random multi-version histories and cutoffs under
        both time policies, every feature output at ``decision_at <= cutoff`` is invariant
        to deleting future rows and scrubbing attributes only knowable after ``cutoff``."""
        rng = np.random.default_rng(20261111)
        days = pd.bdate_range("2024-01-02", periods=160).date.tolist()
        cal = Calendar(days)
        assets = [ASSET_1, ASSET_2]
        ciks = {ASSET_1: CIK_1, ASSET_2: CIK_2}

        # 1. Synthetic prices (raw, adjusted, daily_returns) with random returns
        raw_rows, adj_rows, dr_rows = [], [], []
        for aid in [*assets, BENCH]:
            px = 100.0
            tr = 1.0
            for d in days:
                ret = float(rng.normal(0.0005, 0.015))
                px = max(5.0, px * (1.0 + ret))
                tr = tr * (1.0 + ret)
                raw_rows.append(
                    {"asset_id": aid, "date": d, "open": px, "close": px, "volume": 1e6}
                )
                adj_rows.append(
                    {"asset_id": aid, "date": d, "open": px, "close": px, "volume": 1e6}
                )
                dr_rows.append(
                    {
                        "asset_id": aid,
                        "date": d.isoformat(),
                        "row_kind": "session",
                        "tr_index": tr,
                    }
                )
        raw_df = pd.DataFrame(raw_rows)
        adj_df = pd.DataFrame(adj_rows)
        dr_df = pd.DataFrame(dr_rows)

        # 2. Synthetic SEC + Finnhub event_observations with delayed captures and link edits
        kinds_pool = [
            ("8-K", "2.02"),
            ("8-K", "5.02"),
            ("8-K/A", "2.02"),
            ("NT 10-Q", ""),
            ("424B5", ""),
            ("SC 13D", ""),
        ]
        ev_rows: list[dict[str, Any]] = []
        for i in range(45):
            day_idx = int(rng.integers(5, 150))
            form, items = kinds_pool[int(rng.integers(0, len(kinds_pool)))]
            f_day = days[day_idx]
            # Mix pre-open 06:00 ET, intraday, and late after-hours acceptances
            pub_ns = (
                int(cal.decisions[day_idx])
                + int(rng.integers(0, 14)) * 3_600_000_000_000
            )
            pub_iso = pd.Timestamp(pub_ns, tz="UTC").isoformat().replace("+00:00", "Z")
            cap_lag_ns = int(rng.choice([0, 2, 10, 48])) * 3_600_000_000_000
            cap_ns = pub_ns + cap_lag_ns
            cap_iso = pd.Timestamp(cap_ns, tz="UTC").isoformat().replace("+00:00", "Z")
            linked = [assets[int(rng.integers(0, 2))]]
            uid = f"sec:test:{i}"
            ev_rows.append(
                {
                    "source": "sec",
                    "event_uid": uid,
                    "observation_sequence": 1,
                    "form": form,
                    "items": items,
                    "filing_date": f_day.isoformat(),
                    "asset_ids": linked,
                    "asset_first_seen_at": {a: cap_iso for a in linked},
                    "public_at": pub_iso,
                    "public_date": f_day.isoformat(),
                    "public_time_precision": "second",
                    "content_first_seen_at": cap_iso,
                    "observation_recorded_at": cap_iso,
                }
            )
            # Half get a second observation later adding or removing the other asset
            if i % 2 == 0:
                rec2_ns = cap_ns + int(rng.integers(24, 120)) * 3_600_000_000_000
                rec2_iso = (
                    pd.Timestamp(rec2_ns, tz="UTC").isoformat().replace("+00:00", "Z")
                )
                linked2 = [ASSET_1, ASSET_2] if i % 4 == 0 else []
                fs_map2 = {a: cap_iso if a in linked else rec2_iso for a in linked2}
                ev_rows.append(
                    {
                        "source": "sec",
                        "event_uid": uid,
                        "observation_sequence": 2,
                        "form": form,
                        "items": items,
                        "filing_date": f_day.isoformat(),
                        "asset_ids": linked2,
                        "asset_first_seen_at": fs_map2,
                        "public_at": pub_iso,
                        "public_date": f_day.isoformat(),
                        "public_time_precision": "second",
                        "content_first_seen_at": cap_iso,
                        "observation_recorded_at": rec2_iso,
                    }
                )

        # Add Finnhub earnings calendar observations + link removals
        earn_obs_rows: list[dict[str, Any]] = []
        for q_i, ev_idx in enumerate([35, 75, 115, 145]):
            uid = f"finnhub_earnings:cal:{q_i}"
            obs1_ns = int(cal.decisions[max(2, ev_idx - 20)])
            obs1_iso = (
                pd.Timestamp(obs1_ns, tz="UTC").isoformat().replace("+00:00", "Z")
            )
            obs2_ns = int(cal.decisions[max(4, ev_idx - 8)])
            obs2_iso = (
                pd.Timestamp(obs2_ns, tz="UTC").isoformat().replace("+00:00", "Z")
            )
            ev_rows.append(
                {
                    "source": "finnhub_earnings",
                    "event_uid": uid,
                    "observation_sequence": 1,
                    "form": "",
                    "items": "",
                    "filing_date": "",
                    "asset_ids": [ASSET_1, ASSET_2],
                    "asset_first_seen_at": {ASSET_1: obs1_iso, ASSET_2: obs1_iso},
                    "public_at": "",
                    "public_date": "",
                    "public_time_precision": "unknown",
                    "content_first_seen_at": obs1_iso,
                    "observation_recorded_at": obs1_iso,
                }
            )
            ev_rows.append(
                {
                    "source": "finnhub_earnings",
                    "event_uid": uid,
                    "observation_sequence": 2,
                    "form": "",
                    "items": "",
                    "filing_date": "",
                    "asset_ids": [ASSET_1],  # remove ASSET_2 at obs2
                    "asset_first_seen_at": {ASSET_1: obs1_iso},
                    "public_at": "",
                    "public_date": "",
                    "public_time_precision": "unknown",
                    "content_first_seen_at": obs1_iso,
                    "observation_recorded_at": obs2_iso,
                }
            )
            for aid in (ASSET_1, ASSET_2):
                earn_obs_rows.append(
                    {
                        "event_uid": uid,
                        "asset_id": aid,
                        "symbol": "SYN",
                        "event_date": days[ev_idx].isoformat(),
                        "fiscal_year": 2024,
                        "fiscal_quarter": q_i + 1,
                        "eps_estimate": 1.25 + 0.1 * q_i,
                        "observed_at": obs1_iso,
                        "observation_sequence": 1,
                    }
                )
            earn_obs_rows.append(
                {
                    "event_uid": uid,
                    "asset_id": ASSET_1,
                    "symbol": "SYN",
                    "event_date": days[min(len(days) - 1, ev_idx + 1)].isoformat(),
                    "fiscal_year": 2024,
                    "fiscal_quarter": q_i + 1,
                    "eps_estimate": 1.33 + 0.1 * q_i,
                    "observed_at": obs2_iso,
                    "observation_sequence": 2,
                }
            )

        ev_df = pd.DataFrame(ev_rows)
        earn_obs_df = pd.DataFrame(earn_obs_rows)

        # 3. Synthetic earnings_announcements with prelim + full candidates and delayed reactions
        ann_rows: list[dict[str, Any]] = []
        periods = ["2023-12-31", "2024-03-31", "2024-06-30"]
        base_slots = [22, 68, 118]
        for aid in assets:
            for p_i, (pe, slot) in enumerate(zip(periods, base_slots)):
                for cand_j, offset in enumerate((0, 6)):
                    idx = slot + offset
                    pub_ns = int(cal.decisions[idx]) + 2 * 3_600_000_000_000
                    obs_ns = pub_ns + (6 * 3_600_000_000_000 if cand_j == 1 else 0)
                    r_shift = int(rng.choice([-1, 0, 1]))
                    r_idx = idx + r_shift
                    rk_idx = max(idx + 1, r_idx + 1)
                    rk_ns = int(cal.closes[rk_idx])
                    rep_ns = rk_ns + 10 * 86_400_000_000_000
                    ann_rows.append(
                        {
                            "announcement_id": f"{ciks[aid]}:{p_i}:{cand_j}",
                            "asset_id": aid,
                            "cik": ciks[aid],
                            "kind": "8k_item_2_02"
                            if cand_j == 0
                            else "periodic_report",
                            "role": "results_candidate",
                            "filing_date": days[idx].isoformat(),
                            "public_at": pd.Timestamp(pub_ns, tz="UTC")
                            .isoformat()
                            .replace("+00:00", "Z"),
                            "observed_available_at": pd.Timestamp(obs_ns, tz="UTC")
                            .isoformat()
                            .replace("+00:00", "Z"),
                            "period_end_estimated": pe,
                            "period_end": pe,
                            "report_accession": f"rep-{p_i}",
                            "report_form": "10-Q",
                            "report_public_at": pd.Timestamp(rep_ns, tz="UTC")
                            .isoformat()
                            .replace("+00:00", "Z"),
                            "reaction_session_initial": days[idx].isoformat(),
                            "reaction_session": days[r_idx].isoformat(),
                            "reaction_basis": "confirmed",
                            "volume_ratio_reaction": 1.6 + 2.5 * cand_j + 0.2 * p_i,
                            "reaction_known_at": pd.Timestamp(rk_ns, tz="UTC")
                            .isoformat()
                            .replace("+00:00", "Z"),
                            "candidate_rank": cand_j + 1,
                            "candidate_count": 2,
                            "is_primary_final": cand_j == 1,
                        }
                    )
        ann_df = pd.DataFrame(ann_rows)

        # 4. Synthetic fiscal_quarters with 9 quarters (6 historical + 3 inside window) and future restatements
        q_rows: list[dict[str, Any]] = []
        hist_pes = [
            date(2022, 6, 30),
            date(2022, 9, 30),
            date(2022, 12, 31),
            date(2023, 3, 31),
            date(2023, 6, 30),
            date(2023, 9, 30),
            date(2023, 12, 31),
            date(2024, 3, 31),
            date(2024, 6, 30),
        ]
        avail_slots = [1, 2, 3, 4, 5, 6, 30, 78, 126]
        for cik in (CIK_1, CIK_2):
            for q_idx, (pe, s_idx) in enumerate(zip(hist_pes, avail_slots)):
                av_ts = pd.Timestamp(int(cal.decisions[s_idx]), tz="UTC")
                late_ts = av_ts + pd.Timedelta(days=90)
                q_rows.append(
                    {
                        "cik": cik,
                        "concept": "eps_diluted",
                        "period_end": pe,
                        "value_first": 1.10
                        + 0.09 * q_idx
                        + (0.03 if q_idx % 2 else -0.02),
                        "prior_year_value_first": 1.00 + 0.07 * q_idx,
                        "basis_first": "reported",
                        "status_first": "ok",
                        "available_at_first": av_ts,
                        "value_latest": 99.0,  # future restatement — must NEVER leak!
                        "available_at_latest": late_ts,
                    }
                )
                q_rows.append(
                    {
                        "cik": cik,
                        "concept": "revenue",
                        "period_end": pe,
                        "value_first": 1000.0
                        + 65.0 * q_idx
                        + (25.0 if q_idx % 2 else -15.0),
                        "prior_year_value_first": 920.0 + 55.0 * q_idx,
                        "basis_first": "reported",
                        "status_first": "ok",
                        "available_at_first": av_ts,
                        "value_latest": 999999.0,
                        "available_at_latest": late_ts,
                    }
                )
        q_df = pd.DataFrame(q_rows)

        sample_indices = list(range(10, 150, 4))
        all_samples = _sample_rows(cal, assets, sample_indices)
        wanted_kinds = [
            "results_release",
            "officer_director_change",
            "current_report_amendment",
            "late_filing_notice",
            "prospectus_supplement",
            "activist_stake",
        ]

        # Test across 15 cutoffs for observed_content AND public_reconstructed
        cutoff_indices = [18, 23, 25, 29, 36, 55, 69, 75, 80, 95, 119, 125, 130, 145]
        close_ns_map = {d: int(wall_instants([d], time(16, 0))[0]) for d in days}

        # First verify observed_content strict truncation invariance across all 4 functions
        full_typed_obs = typed_event_features(
            ev_df,
            all_samples,
            kinds=wanted_kinds,
            calendar=cal,
            windows=(10, 63),
            time_policy="observed_content",
        )
        full_earn_obs = earnings_features(
            ann_df,
            all_samples,
            calendar=cal,
            adjusted=adj_df,
            daily_returns=dr_df,
            benchmark_id=BENCH,
            time_policy="observed_content",
            event_observations=ev_df,
            earnings_observations=earn_obs_df,
            horizons=(5, 21),
        )
        full_sue = sue_features(
            q_df,
            all_samples,
            raw=raw_df,
            asset_ciks=ciks,
            primary_period_end=full_earn_obs.attrs["primary_period_end"],
        )

        ev_pub_ns = instants(ev_df["public_at"].to_numpy(dtype=object))
        ev_cap_ns = instants(ev_df["content_first_seen_at"].to_numpy(dtype=object))
        ev_rec_ns = instants(ev_df["observation_recorded_at"].to_numpy(dtype=object))
        ann_pub_ns = instants(ann_df["public_at"].to_numpy(dtype=object))
        ann_obs_ns = instants(ann_df["observed_available_at"].to_numpy(dtype=object))
        ann_rk_ns = instants(ann_df["reaction_known_at"].to_numpy(dtype=object))
        ann_rep_ns = instants(ann_df["report_public_at"].to_numpy(dtype=object))
        earn_obs_ns = instants(earn_obs_df["observed_at"].to_numpy(dtype=object))
        q_avail_ns = instants(q_df["available_at_first"].to_numpy(dtype=object))
        sample_dec_ns = instants(all_samples["decision_at"].to_numpy(dtype=object))

        for c_idx in cutoff_indices:
            c_ns = int(cal.decisions[c_idx])
            c_ts = pd.Timestamp(c_ns, tz="UTC")
            past_mask = sample_dec_ns <= c_ns
            if not past_mask.any():
                continue
            sub_samples = all_samples.loc[past_mask].reset_index(drop=True)

            # Truncate event_observations to versions available by c_ns under observed_content
            # (for SEC rows: max(pub, max(cap, rec) - GRACE) <= c_ns; for finnhub_earnings: rec <= c_ns)
            sec_avail = np.maximum(
                ev_pub_ns, np.maximum(ev_cap_ns, ev_rec_ns) - GRACE_NS
            )
            is_fh = ev_df["source"].astype(str).to_numpy() == "finnhub_earnings"
            ev_keep = np.where(is_fh, ev_rec_ns <= c_ns, sec_avail <= c_ns)
            ev_trunc = ev_df.loc[ev_keep].copy().reset_index(drop=True)

            earn_obs_trunc = (
                earn_obs_df.loc[earn_obs_ns <= c_ns].copy().reset_index(drop=True)
            )

            # Truncate and scrub earnings_announcements
            ann_avail = np.maximum(ann_pub_ns, ann_obs_ns - GRACE_NS)
            ann_keep = ann_avail <= c_ns
            ann_trunc = ann_df.loc[ann_keep].copy().reset_index(drop=True)
            rk_sub = ann_rk_ns[ann_keep]
            rep_sub = ann_rep_ns[ann_keep]
            # Scrub reaction attributes not yet known at c_ns!
            future_rk = rk_sub > c_ns
            ann_trunc.loc[future_rk, "reaction_session"] = ""
            ann_trunc.loc[future_rk, "volume_ratio_reaction"] = np.nan
            ann_trunc.loc[future_rk, "reaction_known_at"] = ""
            ann_trunc.loc[future_rk, "reaction_basis"] = "pending"
            # Scrub future matched periodic report attributes and poison ex-post columns!
            future_rep = rep_sub > c_ns
            ann_trunc.loc[future_rep, "period_end"] = ""
            ann_trunc.loc[future_rep, "report_accession"] = ""
            ann_trunc.loc[future_rep, "report_form"] = ""
            ann_trunc.loc[future_rep, "report_public_at"] = ""
            ann_trunc["is_primary_final"] = ~ann_trunc["is_primary_final"]
            ann_trunc["candidate_count"] = 999

            # Truncate prices to sessions already closed at c_ns
            closed_days = {d for d, cl_ns in close_ns_map.items() if cl_ns <= c_ns}
            closed_iso = {d.isoformat() for d in closed_days}
            raw_trunc = raw_df[raw_df["date"].isin(closed_days)].reset_index(drop=True)
            adj_trunc = adj_df[adj_df["date"].isin(closed_days)].reset_index(drop=True)
            dr_trunc = dr_df[dr_df["date"].isin(closed_iso)].reset_index(drop=True)

            # Truncate fiscal_quarters and poison *_latest restatement columns!
            q_trunc = q_df.loc[q_avail_ns <= c_ns].copy().reset_index(drop=True)
            q_trunc["value_latest"] = -777777.0
            q_trunc["available_at_latest"] = pd.Timestamp("2099-12-31T00:00:00Z")

            trunc_typed = typed_event_features(
                ev_trunc,
                sub_samples,
                kinds=wanted_kinds,
                calendar=cal,
                windows=(10, 63),
                time_policy="observed_content",
            )
            assert_frame_equal(
                full_typed_obs.loc[past_mask].reset_index(drop=True),
                trunc_typed,
            )

            trunc_earn = earnings_features(
                ann_trunc,
                sub_samples,
                calendar=cal,
                adjusted=adj_trunc,
                daily_returns=dr_trunc,
                benchmark_id=BENCH,
                time_policy="observed_content",
                event_observations=ev_trunc,
                earnings_observations=earn_obs_trunc,
                horizons=(5, 21),
            )
            assert_frame_equal(
                full_earn_obs.loc[past_mask].reset_index(drop=True),
                trunc_earn,
            )

            trunc_sue = sue_features(
                q_trunc,
                sub_samples,
                raw=raw_trunc,
                asset_ciks=ciks,
                primary_period_end=trunc_earn.attrs["primary_period_end"],
            )
            assert_frame_equal(
                full_sue.loc[past_mask].reset_index(drop=True),
                trunc_sue,
            )

            assert_frame_equal(
                earnings_calendar_asof(ev_df, earn_obs_df, c_ts),
                earnings_calendar_asof(ev_trunc, earn_obs_trunc, c_ts),
            )

        # Also verify public_reconstructed announcement invariance across cutoffs
        full_earn_pub = earnings_features(
            ann_df,
            all_samples,
            calendar=cal,
            adjusted=adj_df,
            daily_returns=dr_df,
            benchmark_id=BENCH,
            time_policy="public_reconstructed",
            horizons=(5,),
        )
        for c_idx in cutoff_indices:
            c_ns = int(cal.decisions[c_idx])
            past_mask = sample_dec_ns <= c_ns
            if not past_mask.any():
                continue
            sub_samples = all_samples.loc[past_mask].reset_index(drop=True)
            ann_keep = ann_pub_ns <= c_ns
            ann_trunc = ann_df.loc[ann_keep].copy().reset_index(drop=True)
            future_rk = ann_rk_ns[ann_keep] > c_ns
            ann_trunc.loc[future_rk, "reaction_session"] = ""
            ann_trunc.loc[future_rk, "volume_ratio_reaction"] = np.nan
            ann_trunc.loc[future_rk, "reaction_known_at"] = ""
            ann_trunc["is_primary_final"] = False
            closed_days = {d for d, cl_ns in close_ns_map.items() if cl_ns <= c_ns}
            closed_iso = {d.isoformat() for d in closed_days}
            trunc_earn_pub = earnings_features(
                ann_trunc,
                sub_samples,
                calendar=cal,
                adjusted=adj_df[adj_df["date"].isin(closed_days)],
                daily_returns=dr_df[dr_df["date"].isin(closed_iso)],
                benchmark_id=BENCH,
                time_policy="public_reconstructed",
                horizons=(5,),
            )
            assert_frame_equal(
                full_earn_pub.loc[past_mask].reset_index(drop=True),
                trunc_earn_pub,
            )

    def test_panel_integrates_typed_events_earnings_sue_and_label_flags(self) -> None:
        sessions = bundle.SESSIONS
        ann_rows = [
            {
                "announcement_id": f"{bundle.CIK_A}:q4",
                "asset_id": bundle.ASSET_A,
                "cik": bundle.CIK_A,
                "source_event_id": "evt-sec-1",
                "kind": "8k_item_2_02",
                "form": "8-K",
                "items": "2.02",
                "role": "results_candidate",
                "accepted_at": f"{sessions[5]}T20:00:00Z",
                "filing_date": sessions[5],
                "report_date": "2025-12-31",
                "public_at": f"{sessions[5]}T20:00:00Z",
                "public_date": sessions[5],
                "observed_available_at": f"{sessions[5]}T20:00:00Z",
                "period_end_estimated": "2025-12-31",
                "period_estimate_basis": "calendar_quarter",
                "period_end": "2025-12-31",
                "period_end_basis": "matched_report",
                "reaction_session_initial": sessions[5],
                "reaction_session": sessions[5],
                "reaction_basis": "confirmed",
                "volume_ratio_reaction": 2.75,
                "reaction_known_at": f"{sessions[6]}T21:00:00Z",
                "is_primary_final": True,
                "derivation_version": "earnings-announcements-v1",
            }
        ]
        vocab = {
            "version": "sec-kinds-v1",
            "kinds": ["results_release", "late_filing_notice"],
            "items": {"2.02": "results_release"},
            "forms": {"NT 10-Q": "late_filing_notice"},
        }
        obs = bundle.default_observations()
        for rec in obs:
            rec.setdefault("items", "")
            rec.setdefault("public_time_basis", "provider_timestamp")
            rec.setdefault("event_kinds", [])
        obs[0]["items"] = "2.02"
        obs[0]["public_time_basis"] = "sec_acceptance"
        obs[0]["event_kinds"] = ["results_release"]
        fin_obs = bundle.observation(
            "finnhub_earnings:aapl:1",
            "finnhub_earnings",
            [bundle.ASSET_A],
            "",
            form="",
            filing_date="",
            event_date=sessions[8],
            content_first_seen_at=f"{sessions[8]}T21:06:00Z",
            observation_recorded_at=f"{sessions[8]}T21:06:00Z",
            asset_first_seen_at={bundle.ASSET_A: f"{sessions[8]}T21:06:00Z"},
            public_time_precision="unknown",
            items="",
            public_time_basis="none",
            event_kinds=[],
        )
        obs.append(fin_obs)
        objects, _ = bundle._build_synthetic_bundle(
            extra_families={"earnings_announcements": ann_rows},
            family_updates={"event_observations": {"schema_version": 2}},
            manifest_updates={"schema_version": 3, "sec_event_kinds": vocab},
        )
        # Override event_observations (schema v2) and earnings_observations parts
        prefix = f"datasets/{bundle.DATASET_ID}"
        manifest_key = f"{prefix}/manifest.json"
        manifest_obj = research_datasets.client.json.loads(
            objects[manifest_key].decode("utf-8")
        )
        ev_obs_schema_v2 = bundle.pa.schema(
            [
                *bundle.OBSERVATION_SCHEMA,
                ("items", bundle.pa.string()),
                ("public_time_basis", bundle.pa.string()),
                ("event_kinds", bundle.pa.list_(bundle.pa.string())),
            ]
        )
        ev_obs_key = f"{prefix}/event_observations/part-0000.parquet"
        ev_obs_bytes = bundle._parquet_bytes(obs, ev_obs_schema_v2)
        objects[ev_obs_key] = ev_obs_bytes
        manifest_obj["data_families"]["event_observations"]["rows"] = len(obs)
        manifest_obj["data_families"]["event_observations"]["bytes"] = len(ev_obs_bytes)
        earn_part_key = f"{prefix}/earnings_observations/part-0000.parquet"
        earn_bytes = bundle._parquet_bytes(
            [
                {
                    "observation_id": "earn-1",
                    "event_uid": "finnhub_earnings:aapl:1",
                    "asset_id": bundle.ASSET_A,
                    "symbol": "AAPL",
                    "event_date": sessions[15],
                    "fiscal_year": 2026,
                    "fiscal_quarter": 1,
                    "hour": "amc",
                    "eps_estimate": 2.10,
                    "observed_at": f"{sessions[8]}T21:06:00Z",
                    "observation_sequence": 1,
                }
            ]
        )
        objects[earn_part_key] = earn_bytes
        manifest_obj["data_families"]["earnings_observations"]["rows"] = 1
        manifest_obj["data_families"]["earnings_observations"]["bytes"] = len(
            earn_bytes
        )
        for entry in manifest_obj["files"]:
            if entry["key"] in (ev_obs_key, earn_part_key):
                payload = objects[entry["key"]]
                entry["sha256"] = bundle.hashlib.sha256(payload).hexdigest()
                entry["size_bytes"] = len(payload)
        objects[manifest_key] = research_datasets.client.json.dumps(
            manifest_obj
        ).encode("utf-8")

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
            specs = ds.sec_event_specs()
            self.assertEqual(
                [s.name for s in specs],
                ["sec_kind_results_release", "sec_kind_late_filing_notice"],
            )
            ann_read = ds.earnings_announcements("AAPL")
            self.assertEqual(len(ann_read), 1)

            cal_read = ds.earnings_calendar("AAPL", asof=f"{sessions[9]}T12:00:00Z")
            self.assertEqual(len(cal_read), 1)
            self.assertEqual(cal_read.loc[0, "event_date"], sessions[15])

            panel_df = ds.panel(
                ["AAPL", "GOOG"],
                start=sessions[4],
                end=sessions[12],
                horizons=(1, 5),
                time_policy="public_reconstructed",
                allow_static_universe=True,
            )
            self.assertIn("sec_kind_results_release_count_63s", panel_df.columns)
            self.assertIn("sec_kind_late_filing_notice_days_since", panel_df.columns)
            self.assertIn("earn_volume_ratio", panel_df.columns)
            self.assertIn("earn_ear", panel_df.columns)
            self.assertIn("earn_next_within_5s", panel_df.columns)
            self.assertIn("earn_sue_eps_price", panel_df.columns)
            self.assertIn("earn_sue_revenue", panel_df.columns)
            self.assertIn("label_has_earnings_5d", panel_df.columns)
            self.assertIn("label_primary_earnings_5d", panel_df.columns)

            aapl_rows = panel_df[panel_df["symbol"] == "AAPL"].reset_index(drop=True)
            # Signal session[4] -> entry session[5] -> decision 06:00 ET on session[5]:
            # announcement on session[5] at 20:00Z is NOT yet public!
            self.assertTrue(pd.isna(aapl_rows.loc[0, "earn_days_since"]))
            # Label window (4, 9] DOES contain reaction session[5]!
            self.assertEqual(bool(aapl_rows.loc[0, "label_has_earnings_5d"]), True)
            # By signal session[7] (after reaction_known_at on session[6] close), EAR and ratio are known!
            row_after = aapl_rows[
                aapl_rows["signal_session"] == date.fromisoformat(sessions[7])
            ].iloc[0]
            self.assertAlmostEqual(row_after["earn_volume_ratio"], 2.75)
            self.assertTrue(pd.notna(row_after["earn_ear"]))


if __name__ == "__main__":
    unittest.main()
