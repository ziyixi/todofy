"""Unit tests for SDK 2.6 data-foundation upgrades (stores, labels, signals, cutoff & dedup)."""

from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

import research_datasets
from research_datasets import clocks
from research_datasets.labels import (
    gauss_rank_cross_section,
    residual_vol_63d,
    welch_beta_252d,
)
from research_datasets.materialize import audit_features
from research_datasets.stores import (
    EventStore,
    build_event_store,
    build_fund_store,
    build_macro_store,
    build_price_store,
)
from tests.test_stores_and_materialize import (
    ASSET_1,
    ASSET_SPY,
    CIK_1,
    _et_iso,
    _nyse_sessions,
    _SyntheticVersion,
)

ASSET_1B = "11111111-1111-4111-8111-111111111112"
ASSET_2 = "22222222-2222-4222-8222-222222222222"
ASSET_3 = "33333333-3333-4333-8333-333333333333"
ASSET_QQQ = "99999999-9999-4999-8999-999999999998"
ASSET_GLD = "99999999-9999-4999-8999-999999999997"
CIK_2 = "0000000002"
CIK_3 = "0000000003"


def _make_price_rows(
    sessions: list[date],
    asset_prices: dict[str, tuple[np.ndarray, np.ndarray]],
    *,
    extra_dr_flags: dict[tuple[str, int], dict[str, Any]] | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    p_rows: list[dict[str, Any]] = []
    dr_rows: list[dict[str, Any]] = []
    extra = extra_dr_flags or {}
    for aid, (closes, vols) in asset_prices.items():
        base = float(closes[0]) if closes[0] > 0 else 100.0
        for idx, d in enumerate(sessions):
            c = float(closes[idx])
            v = float(vols[idx])
            if not np.isfinite(c) or c <= 0:
                continue
            p_rows.append(
                {
                    "asset_id": aid,
                    "date": d.isoformat(),
                    "open": c * 0.995,
                    "high": c * 1.01,
                    "low": c * 0.99,
                    "close": c,
                    "volume": v,
                    "vwap": c,
                    "trade_count": max(1.0, v / 100.0),
                    "adjustment": "all",
                }
            )
            ov = extra.get((aid, idx), {})
            dr_rows.append(
                {
                    "asset_id": aid,
                    "date": d.isoformat(),
                    "row_kind": "first" if idx == 0 else "session",
                    "open_raw": c * 0.995,
                    "close_raw": c,
                    "tr_index": ov.get("tr_index", c / base),
                    "tr_status": ov.get("tr_status", "first" if idx == 0 else "ok"),
                    "terminal_basis": "",
                    "cash_amount": 0.0,
                    "split_index": ov.get("split_index", 1.0),
                    "flags": ov.get("flags", []),
                }
            )
    return pd.DataFrame(p_rows), pd.DataFrame(dr_rows)


class SdkV26UpgradesTest(unittest.TestCase):
    def test_fund_store_q4_derivation_concept_fixes_and_causal_splits(self) -> None:
        sessions = _nyse_sessions(date(2024, 1, 2), 260)
        cal = clocks.Calendar(sessions)
        universe = [
            {
                "asset_id": ASSET_1,
                "symbol": "AAA",
                "cik": CIK_1,
                "issuer_mapping_status": "verified",
                "security_type": "common",
                "status": "active",
                "is_benchmark": False,
            }
        ]
        # 4-for-1 split on 2024-09-01 (between Q2 filing and FY 10-K filing)
        ca_df = pd.DataFrame(
            [
                {
                    "action_uid": "sp-1",
                    "asset_id": ASSET_1,
                    "role": "subject",
                    "type": "split",
                    "effect_date": "2024-09-01",
                    "split_ratio": 4.0,
                    "observation_sequence": 1,
                    "is_retracted": False,
                    "status": "active",
                }
            ]
        )
        facts: list[dict[str, Any]] = []
        fid = 0

        def add_fact(
            tax: str,
            tag: str,
            unit: str,
            ps: str | None,
            pe: str,
            form: str,
            filed: str,
            val: str,
        ) -> None:
            nonlocal fid
            fid += 1
            pub_iso = f"{filed}T16:30:00-04:00"
            facts.append(
                {
                    "fact_id": f"f-{fid}",
                    "cik": CIK_1,
                    "metric": tag,
                    "source": "sec",
                    "taxonomy": tax,
                    "tag": tag,
                    "tag_priority": 1,
                    "unit": unit,
                    "currency": "USD" if unit in {"USD", "USD/shares"} else "",
                    "period_start": ps,
                    "period_end": pe,
                    "period_kind": "instant" if ps is None else "duration",
                    "form": form,
                    "accession": f"0001-{fid:04d}",
                    "filed": filed,
                    "public_at": pub_iso,
                    "public_date": filed,
                    "public_time_precision": "second",
                    "value": val,
                    "observed_at": pub_iso,
                    "content_first_seen_at": pub_iso,
                    "observation_sequence": fid,
                    "is_retracted": False,
                }
            )

        # Q1 2024 (pre-split, filed 2024-05-01): Rev=$100M, NI=$20M, 5M shares -> EPS=$4.00
        add_fact(
            "us-gaap",
            "Revenues",
            "USD",
            "2024-01-01",
            "2024-03-31",
            "10-Q",
            "2024-05-01",
            "100000000",
        )
        add_fact(
            "us-gaap",
            "NetIncomeLoss",
            "USD",
            "2024-01-01",
            "2024-03-31",
            "10-Q",
            "2024-05-01",
            "20000000",
        )
        add_fact(
            "us-gaap",
            "EarningsPerShareDiluted",
            "USD/shares",
            "2024-01-01",
            "2024-03-31",
            "10-Q",
            "2024-05-01",
            "4.00",
        )
        add_fact(
            "us-gaap",
            "StockholdersEquity",
            "USD",
            None,
            "2024-03-31",
            "10-Q",
            "2024-05-01",
            "500000000",
        )
        add_fact(
            "dei",
            "EntityCommonStockSharesOutstanding",
            "shares",
            None,
            "2024-03-31",
            "10-Q",
            "2024-05-01",
            "5000000",
        )

        # Q2 2024 (6M YTD + 3M, pre-split, filed 2024-08-01): Rev YTD=$220M (Q2=$120M), NI YTD=$45M (Q2=$25M)
        add_fact(
            "us-gaap",
            "Revenues",
            "USD",
            "2024-01-01",
            "2024-06-30",
            "10-Q",
            "2024-08-01",
            "220000000",
        )
        add_fact(
            "us-gaap",
            "NetIncomeLoss",
            "USD",
            "2024-01-01",
            "2024-06-30",
            "10-Q",
            "2024-08-01",
            "45000000",
        )
        add_fact(
            "us-gaap",
            "EarningsPerShareDiluted",
            "USD/shares",
            "2024-04-01",
            "2024-06-30",
            "10-Q",
            "2024-08-01",
            "5.00",
        )

        # Q3 2024 (9M YTD only, post-split 20M shares, filed 2024-11-01): Rev YTD=$350M (Q3=$130M), NI YTD=$75M (Q3=$30M)
        add_fact(
            "us-gaap",
            "Revenues",
            "USD",
            "2024-01-01",
            "2024-09-30",
            "10-Q",
            "2024-11-01",
            "350000000",
        )
        add_fact(
            "us-gaap",
            "NetIncomeLoss",
            "USD",
            "2024-01-01",
            "2024-09-30",
            "10-Q",
            "2024-11-01",
            "75000000",
        )
        add_fact(
            "us-gaap",
            "EarningsPerShareDiluted",
            "USD/shares",
            "2024-07-01",
            "2024-09-30",
            "10-Q",
            "2024-11-01",
            "1.50",
        )

        # FY 2024 10-K (NO standalone Q4! Must derive Q4 = FY - 9M: rev=$150M, ni=$35M)
        add_fact(
            "us-gaap",
            "Revenues",
            "USD",
            "2024-01-01",
            "2024-12-31",
            "10-K",
            "2025-02-15",
            "500000000",
        )
        add_fact(
            "us-gaap",
            "NetIncomeLoss",
            "USD",
            "2024-01-01",
            "2024-12-31",
            "10-K",
            "2025-02-15",
            "110000000",
        )
        add_fact(
            "us-gaap",
            "EarningsPerShareDiluted",
            "USD/shares",
            "2024-01-01",
            "2024-12-31",
            "10-K",
            "2025-02-15",
            "5.50",
        )

        ver = _SyntheticVersion(
            calendar=sessions,
            universe=universe,
            families={
                "fundamentals": pd.DataFrame(facts),
                "corporate_actions": ca_df,
            },
            prices_adj=pd.DataFrame(),
            prices_raw=pd.DataFrame(),
            manifest_extra={"source_timezones": {"sec": "America/New_York"}},
        )
        fstore = build_fund_store(
            ver,
            [CIK_1],
            time_policy="public_reconstructed",
            cal=cal,
        )
        # Snapshot 0 (filed 2024-05-01, BEFORE 2024-09-01 4:1 split): EPS = 4.0, shares = 5M, equity = $500M
        snap0 = fstore.slice_snapshot(
            0, int(clocks.clock("2024-05-02T10:00:00Z").value)
        )
        self.assertEqual(snap0["values"].shape[0], 1)
        self.assertAlmostEqual(float(snap0["values"][0, 0]), 100_000_000.0, places=0)
        self.assertAlmostEqual(
            float(snap0["values"][0, 6]), 4.0, places=3
        )  # diluted_eps (unsplit!)
        self.assertAlmostEqual(float(snap0["values"][0, 12]), 500_000_000.0, places=0)
        self.assertAlmostEqual(
            float(snap0["values"][0, 14]), 5_000_000.0, places=0
        )  # shares (unsplit!)

        # Final snapshot (filed 2025-02-15, AFTER 2024-09-01 4:1 split):
        # Should contain all 4 quarters including derived Q2 ($120M), Q3 ($130M), Q4 ($150M),
        # AND Q1 EPS scaled 4.0 -> 1.0, Q1 shares scaled 5M -> 20M!
        last_id = len(fstore.snap_epoch_ns) - 1
        snap_last = fstore.slice_snapshot(
            last_id, int(clocks.clock("2025-02-16T10:00:00Z").value)
        )
        pes = [date.fromordinal(int(o)) for o in snap_last["period_end_ordinals"]]
        self.assertEqual(
            pes,
            [
                date(2024, 3, 31),
                date(2024, 6, 30),
                date(2024, 9, 30),
                date(2024, 12, 31),
            ],
        )
        revs = snap_last["values"][:, 0].tolist()
        nis = snap_last["values"][:, 3].tolist()
        self.assertAlmostEqual(revs[0], 100_000_000.0, places=0)
        self.assertAlmostEqual(revs[1], 120_000_000.0, places=0)
        self.assertAlmostEqual(revs[2], 130_000_000.0, places=0)
        self.assertAlmostEqual(revs[3], 150_000_000.0, places=0)
        self.assertAlmostEqual(nis[3], 35_000_000.0, places=0)
        # Pre-split Q1 EPS (4.0) divided by 4 -> 1.0; Q1 shares (5M) * 4 -> 20M
        self.assertAlmostEqual(float(snap_last["values"][0, 6]), 1.0, places=3)
        self.assertAlmostEqual(
            float(snap_last["values"][0, 14]), 20_000_000.0, places=0
        )

    def test_event_store_typed_kinds_benchmark_residual_and_dated_llm_mapping(
        self,
    ) -> None:
        sessions = _nyse_sessions(date(2025, 1, 2), 30)
        cal = clocks.Calendar(sessions)
        universe = [
            {
                "asset_id": ASSET_1,
                "symbol": "OLDCO",
                "cik": CIK_1,
                "issuer_mapping_status": "verified",
                "security_type": "common",
                "status": "delisted",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_2,
                "symbol": "NEWCO",
                "cik": CIK_1,
                "issuer_mapping_status": "verified",
                "security_type": "common",
                "status": "active",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_SPY,
                "symbol": "SPY",
                "cik": "",
                "security_type": "etf",
                "status": "active",
                "is_benchmark": True,
            },
        ]
        # Session 10: ASSET_1 rises +10%, SPY rises +2% -> benchmark-adjusted 1d reaction = +8%
        c1 = np.full(len(sessions), 100.0)
        c1[10:] = 110.0
        c2 = np.full(len(sessions), 50.0)
        c_spy = np.full(len(sessions), 100.0)
        c_spy[10:] = 102.0
        vols = np.full(len(sessions), 1_000_000.0)
        prices_df, dr_df = _make_price_rows(
            sessions,
            {ASSET_1: (c1, vols), ASSET_2: (c2, vols), ASSET_SPY: (c_spy, vols)},
        )

        day_t = sessions[10]
        ev_date = sessions[8]
        pre_iso = _et_iso(day_t, 8, 30)
        events_df = pd.DataFrame(
            [
                {
                    "source": "sec",
                    "event_uid": "8k-exec",
                    "form": "8-K",
                    "items": "5.02",
                    "event_kinds": ["officer_director_change"],
                    "filing_date": day_t.isoformat(),
                    "event_date": ev_date.isoformat(),
                    "asset_ids": [ASSET_1],
                    "content_first_seen_at": pre_iso,
                    "observation_recorded_at": pre_iso,
                    "observation_sequence": 1,
                    "public_time_precision": "second",
                    "public_at": pre_iso,
                    "public_date": day_t.isoformat(),
                },
                {
                    "source": "alpaca_news",
                    "event_uid": "news-1",
                    "form": None,
                    "items": "",
                    "event_kinds": [],
                    "filing_date": None,
                    "event_date": day_t.isoformat(),
                    "asset_ids": [ASSET_1],
                    "content_first_seen_at": pre_iso,
                    "observation_recorded_at": pre_iso,
                    "observation_sequence": 1,
                    "public_time_precision": "second",
                    "public_at": pre_iso,
                    "public_date": day_t.isoformat(),
                },
            ]
        )
        # Issuer history: ASSET_1 owns CIK_1 up to sessions[9]; ASSET_2 owns CIK_1 from sessions[10]+
        ih_df = pd.DataFrame(
            [
                {
                    "asset_id": ASSET_1,
                    "cik": CIK_1,
                    "status": "verified",
                    "effective_from": sessions[0].isoformat(),
                    "effective_to": sessions[9].isoformat(),
                },
                {
                    "asset_id": ASSET_2,
                    "cik": CIK_1,
                    "status": "verified",
                    "effective_from": sessions[10].isoformat(),
                    "effective_to": None,
                },
            ]
        )
        facts_df = pd.DataFrame(
            [
                {
                    "cik": CIK_1,
                    "extractor_version": "ext-prod",
                    "run_index": 1,
                    "validation_status": "valid",
                    "accepted_at": pre_iso,
                    "recorded_at": pre_iso,
                    "fact_type": "guidance",
                    "action": "raised",
                    "value_low_base": 250.0,
                },
                {
                    "cik": CIK_1,
                    "extractor_version": "ext-old-dev",
                    "run_index": 1,
                    "validation_status": "valid",
                    "accepted_at": pre_iso,
                    "recorded_at": pre_iso,
                    "fact_type": "guidance",
                    "action": "lowered",
                    "value_low_base": 100.0,
                },
            ]
        )
        ver = _SyntheticVersion(
            calendar=sessions,
            universe=universe,
            families={
                "daily_returns": dr_df,
                "event_observations": events_df,
                "issuer_history": ih_df,
                "extraction_facts": facts_df,
            },
            prices_adj=prices_df,
            prices_raw=prices_df,
            manifest_extra={
                "source_timezones": {
                    "sec": "America/New_York",
                    "alpaca_news": "America/New_York",
                },
                "extraction": {"default_extractor_version": "ext-prod"},
            },
        )
        pstore = build_price_store(
            ver, [ASSET_1, ASSET_2, ASSET_SPY], cal.days, benchmark_id=ASSET_SPY
        )
        estore = build_event_store(
            ver,
            pstore.assets,
            time_policy="public_reconstructed",
            cal=cal,
            price_store=pstore,
        )
        # News excluded by default; fine-grained SEC kind preserved; old extractor filtered out
        self.assertIn("officer_director_change", estore.kinds)
        self.assertIn("llm:guidance:raised", estore.kinds)
        self.assertNotIn("llm:guidance:lowered", estore.kinds)
        self.assertNotIn("alpaca_news", estore.kinds)

        dec_t1 = int(cal.decisions[11])
        sl1 = estore.slice_asset_events(0, dec_t1)
        # ASSET_1 gets SEC 8-K (benchmark-adjusted +10% - +2% = +8%), NOT the sessions[10] LLM fact!
        self.assertEqual(len(sl1["public_at_ns"]), 1)
        self.assertEqual(int(sl1["event_date_ordinals"][0]), ev_date.toordinal())
        self.assertAlmostEqual(float(sl1["post_1d_ret"][0]), 0.08, places=4)

        sl2 = estore.slice_asset_events(1, dec_t1)
        # ASSET_2 receives the sessions[10] LLM fact via verified issuer_history interval
        self.assertEqual(len(sl2["public_at_ns"]), 1)
        self.assertEqual(estore.kinds[int(sl2["kind_code"][0])], "llm:guidance:raised")

        # Save & load preserves event_date_ordinals
        with tempfile.TemporaryDirectory() as tmp:
            estore.save(Path(tmp))
            loaded = EventStore.load(Path(tmp))
            np.testing.assert_array_equal(
                loaded.event_date_ordinals, estore.event_date_ordinals
            )

    def test_price_dual_masks_and_macro_raw_levels(self) -> None:
        sessions = _nyse_sessions(date(2025, 1, 2), 30)
        cal = clocks.Calendar(sessions)
        universe = [
            {
                "asset_id": ASSET_1,
                "symbol": "AAA",
                "security_type": "common",
                "status": "active",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_SPY,
                "symbol": "SPY",
                "security_type": "etf",
                "status": "active",
                "is_benchmark": True,
            },
            {
                "asset_id": ASSET_QQQ,
                "symbol": "QQQ",
                "security_type": "etf",
                "status": "active",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_GLD,
                "symbol": "GLD",
                "security_type": "etf",
                "status": "active",
                "is_benchmark": False,
            },
        ]
        c_base = 100.0 * np.cumprod(np.r_[1.0, np.full(len(sessions) - 1, 1.002)])
        vols = np.full(len(sessions), 500_000.0)
        vols[5] = 0.0
        vols[6] = 0.0  # consecutive zero-volume zombie bar -> bar_invalid
        prices_df, dr_df = _make_price_rows(
            sessions,
            {
                ASSET_1: (c_base, vols),
                ASSET_SPY: (c_base, np.full(len(sessions), 2e6)),
                ASSET_QQQ: (c_base * 1.01, np.full(len(sessions), 2e6)),
                ASSET_GLD: (c_base * 0.99, np.full(len(sessions), 1e6)),
            },
            extra_dr_flags={
                (ASSET_1, 10): {"flags": ["adjustment_suspect"]},  # bar_invalid = 1
                (ASSET_1, 15): {
                    "tr_status": "disputed"
                },  # bar_extreme = 1, bar_invalid = 0
            },
        )
        ref_rows = []
        for idx, d in enumerate(sessions[:-1]):
            av = _et_iso(sessions[idx + 1], 0, 0)
            for sid, val in (
                ("DGS10", 4.2 + 0.01 * idx),
                ("VIXCLS", 32.0),
                ("VXVCLS", 26.0),
            ):
                ref_rows.append(
                    {
                        "series_id": sid,
                        "date": d.isoformat(),
                        "value": val,
                        "observation_sequence": 1,
                        "observed_at": av,
                        "available_at": av,
                    }
                )
        ver = _SyntheticVersion(
            calendar=sessions,
            universe=universe,
            families={
                "daily_returns": dr_df,
                "reference_series": pd.DataFrame(ref_rows),
            },
            prices_adj=prices_df,
            prices_raw=prices_df,
        )
        pstore = build_price_store(
            ver,
            [ASSET_1, ASSET_SPY, ASSET_QQQ, ASSET_GLD],
            cal.days,
            benchmark_id=ASSET_SPY,
        )
        inv = pstore.channel("bar_invalid")[0]
        ext = pstore.channel("bar_extreme")[0]
        self.assertEqual(float(inv[6]), 1.0)
        self.assertEqual(float(inv[10]), 1.0)
        self.assertEqual(float(inv[15]), 0.0)
        self.assertEqual(float(ext[15]), 1.0)
        self.assertTrue(np.isfinite(pstore.channel("log_dollar_volume")[0, 12]))
        self.assertTrue(np.isfinite(pstore.channel("hl_range_ratio")[0, 12]))
        self.assertTrue(np.isfinite(pstore.channel("open_close_ratio")[0, 12]))

        mstore = build_macro_store(
            ver,
            cal.days,
            time_policy="public_reconstructed",
            cal=cal,
            price_store=pstore,
        )
        self.assertIn("raw_dgs10", mstore.columns)
        self.assertIn("raw_vixcls", mstore.columns)
        self.assertIn("etf_ret_1d_gld", mstore.columns)
        self.assertIn("etf_qqq_spy_21d", mstore.columns)
        vix_col = mstore.columns.index("raw_vixcls")
        self.assertAlmostEqual(float(mstore.data[20, vix_col]), 32.0, places=3)

    def test_welch_beta_resvol_gauss_rank_and_dense_risk_cutoff(self) -> None:
        rng = np.random.default_rng(7)
        t_len = 280
        mkt = rng.normal(0.0004, 0.01, size=t_len)
        # Asset 0: beta=1.5 with one extreme +80% outlier day; Asset 1: beta=0.8; Asset 2: dead-water low vol; Asset 3: IPO last 40d
        r0 = 1.5 * mkt + rng.normal(0.0, 0.005, size=t_len)
        r0[120] = 0.80  # extreme outlier clipped by Welch symmetric bounds
        r1 = 0.8 * mkt + rng.normal(0.0, 0.012, size=t_len)
        r2 = 1.0 * mkt + rng.normal(0.0, 0.0001, size=t_len)
        r3 = np.full(t_len, np.nan)
        r3[-40:] = 1.2 * mkt[-40:] + rng.normal(0.0, 0.01, size=40)
        ret = np.vstack([r0, r1, r2, r3])

        beta = welch_beta_252d(ret, mkt, window=252, min_periods=200)
        # Asset 0 Welch beta stays near 1.5 despite +80% outlier
        self.assertTrue(1.2 < float(beta[0, -1]) < 1.8)
        self.assertTrue(0.6 < float(beta[1, -1]) < 1.0)
        # IPO asset 3 (<200 days) falls back to cross-sectional median
        med_last = float(np.median([beta[0, -1], beta[1, -1], beta[2, -1]]))
        self.assertAlmostEqual(float(beta[3, -1]), med_last, places=6)

        rvol = residual_vol_63d(
            ret, mkt, beta, window=63, min_periods=42, floor_quantile=0.25
        )
        # Dead-water asset 2 is floored up to the cross-sectional 25% quantile
        self.assertGreater(float(rvol[2, -1]), 0.001)

        gr = gauss_rank_cross_section(
            np.array([1.0, 2.0, 3.0, 4.0]),
            np.array([date(2025, 1, 2)] * 4),
            np.array([True, True, True, True]),
        )
        self.assertAlmostEqual(float(np.mean(gr)), 0.0, places=5)
        self.assertTrue(np.all(np.diff(gr) > 0.0))

    def test_materialize_cutoff_dedup_and_three_new_signal_groups(self) -> None:
        rng = np.random.default_rng(42)
        sessions = _nyse_sessions(date(2024, 1, 2), 290)
        universe = [
            {
                "asset_id": ASSET_1,
                "symbol": "DUALA",
                "cik": CIK_1,
                "issuer_mapping_status": "verified",
                "security_type": "common",
                "status": "active",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_1B,
                "symbol": "DUALB",
                "cik": CIK_1,
                "issuer_mapping_status": "verified",
                "security_type": "common",
                "status": "active",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_2,
                "symbol": "PEERX",
                "cik": CIK_2,
                "issuer_mapping_status": "verified",
                "security_type": "common",
                "status": "active",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_3,
                "symbol": "NEWIPO",
                "cik": CIK_3,
                "issuer_mapping_status": "verified",
                "security_type": "common",
                "status": "active",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_SPY,
                "symbol": "SPY",
                "cik": "",
                "security_type": "etf",
                "status": "active",
                "is_benchmark": True,
            },
            {
                "asset_id": ASSET_QQQ,
                "symbol": "QQQ",
                "cik": "",
                "security_type": "etf",
                "status": "active",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_GLD,
                "symbol": "GLD",
                "cik": "",
                "security_type": "etf",
                "status": "active",
                "is_benchmark": False,
            },
        ]
        n_s = len(sessions)
        mkt_r = rng.normal(0.0005, 0.008, size=n_s)
        qqq_spread = rng.normal(0.0002, 0.006, size=n_s)
        shared_factor = rng.normal(0.0, 0.012, size=n_s)

        r_a1 = (
            mkt_r + 1.2 * qqq_spread + shared_factor + rng.normal(0.0, 0.003, size=n_s)
        )
        # Crash ASSET_1 on session 200 (-12%), bounce +3% on session 203 (when delayed 8-K is filed)
        r_a1[200] = -0.12
        r_a1[203] = 0.03
        # Unexplained jump on session 220 (-8%) with no SEC event
        r_a1[220] = -0.08

        r_a2 = mkt_r + 0.8 * shared_factor + rng.normal(0.0, 0.003, size=n_s)
        r_a3 = mkt_r + 0.9 * shared_factor + rng.normal(0.0, 0.003, size=n_s)

        def _cum_px(r: np.ndarray) -> np.ndarray:
            return 100.0 * np.cumprod(1.0 + r)

        c_a1 = _cum_px(r_a1)
        c_a1b = c_a1 * 0.98
        c_a2 = _cum_px(r_a2)
        c_a3 = _cum_px(r_a3)
        c_a3[:200] = (
            np.nan
        )  # Newly listed IPO active from session 200 onward (>=20d by session 225!)
        c_spy = _cum_px(mkt_r)
        c_qqq = _cum_px(mkt_r + qqq_spread)
        c_gld = _cum_px(rng.normal(0.0002, 0.006, size=n_s))

        v_a1 = np.full(n_s, 5_000_000.0)
        v_a1[200] = 20_000_000.0
        v_a1[220] = 18_000_000.0
        v_a1b = np.full(
            n_s, 1_000_000.0
        )  # Lower dollar volume than ASSET_1 -> dropped by dedup!
        v_other = np.full(n_s, 3_000_000.0)

        prices_df, dr_df = _make_price_rows(
            sessions,
            {
                ASSET_1: (c_a1, v_a1),
                ASSET_1B: (c_a1b, v_a1b),
                ASSET_2: (c_a2, v_other),
                ASSET_3: (c_a3, v_other),
                ASSET_SPY: (c_spy, v_other),
                ASSET_QQQ: (c_qqq, v_other),
                ASSET_GLD: (c_gld, v_other),
            },
        )
        # Delayed 8-K (officer_director_change): event_date=session 200, filed=session 203
        iso_203 = _et_iso(sessions[203], 16, 15)
        events_df = pd.DataFrame(
            [
                {
                    "source": "sec",
                    "event_uid": "delayed-8k-exec",
                    "form": "8-K",
                    "items": "5.02",
                    "event_kinds": ["officer_director_change"],
                    "filing_date": sessions[203].isoformat(),
                    "event_date": sessions[200].isoformat(),
                    "asset_ids": [ASSET_1],
                    "content_first_seen_at": iso_203,
                    "observation_recorded_at": iso_203,
                    "observation_sequence": 1,
                    "public_time_precision": "second",
                    "public_at": iso_203,
                    "public_date": sessions[203].isoformat(),
                },
                # Future event past cutoff (session 275) that MUST be excluded when max_date=sessions[250]
                {
                    "source": "sec",
                    "event_uid": "future-8k",
                    "form": "8-K",
                    "items": "1.01",
                    "event_kinds": ["material_agreement"],
                    "filing_date": sessions[275].isoformat(),
                    "event_date": sessions[275].isoformat(),
                    "asset_ids": [ASSET_1],
                    "content_first_seen_at": _et_iso(sessions[275], 9, 0),
                    "observation_recorded_at": _et_iso(sessions[275], 9, 0),
                    "observation_sequence": 1,
                    "public_time_precision": "second",
                    "public_at": _et_iso(sessions[275], 9, 0),
                    "public_date": sessions[275].isoformat(),
                },
            ]
        )
        ref_rows = []
        for idx in range(n_s - 1):
            av = _et_iso(sessions[idx + 1], 0, 0)
            vix_val = 36.0 if idx >= 230 else 16.0
            vxv_val = 28.0 if idx >= 230 else 19.0
            for sid, val in (
                ("DTB3", 4.5),
                ("DGS10", 4.0 + 0.005 * np.sin(idx / 5.0)),
                ("DGS2", 3.8 + 0.004 * np.cos(idx / 7.0)),
                ("BAA10Y", 2.0 if idx < 230 else 3.2),
                ("VIXCLS", vix_val),
                ("VXVCLS", vxv_val),
                ("DCOILWTICO", 75.0 + 2.0 * np.sin(idx / 6.0)),
                ("DTWEXBGS", 120.0 + 1.0 * np.cos(idx / 8.0)),
            ):
                ref_rows.append(
                    {
                        "series_id": sid,
                        "date": sessions[idx].isoformat(),
                        "value": float(val),
                        "observation_sequence": 1,
                        "observed_at": av,
                        "available_at": av,
                    }
                )

        ver = _SyntheticVersion(
            calendar=sessions,
            universe=universe,
            families={
                "daily_returns": dr_df,
                "event_observations": events_df,
                "reference_series": pd.DataFrame(ref_rows),
            },
            prices_adj=prices_df,
            prices_raw=prices_df,
            manifest_extra={"source_timezones": {"sec": "America/New_York"}},
        )
        recipe = {
            "schema_version": 1,
            "sampling": "daily",
            "time_policy": "public_reconstructed",
            "horizons_trading_days": [5, 21],
            "feature_groups": {
                "peer_spillover": {"enabled": True, "top_k": 5, "shrinkage_days": 20.0},
                "sec_shock_interaction": {"enabled": True, "lookback_sessions": 21},
                "macro_sensitivity_crisis": {"enabled": True, "window": 126},
            },
        }
        cutoff_day = sessions[250]
        with tempfile.TemporaryDirectory() as tmp:
            res = research_datasets.materialize(
                ver,
                recipe_yaml=recipe,
                cache_dir=tmp,
                max_date=cutoff_day,
                universe="static",
                benchmark="SPY",
                deduplicate_issuers=True,
                include_labels=True,
            )
            assert res.stores is not None
            assert res.y is not None
            # 1) Hard cutoff guard passes and truncates ALL 4 stores + labels
            res.stores.assert_cutoff(cutoff_day)
            self.assertLessEqual(max(res.stores.prices.sessions), cutoff_day)
            self.assertLessEqual(max(res.stores.macro.sessions), cutoff_day)
            self.assertEqual(
                len(res.stores.events.public_at_ns), 1
            )  # future-8k dropped
            self.assertTrue(audit_features(list(res.X.columns)).empty)

            # Mutating a store session past cutoff triggers CUTOFF_VIOLATION
            res.stores.prices.sessions = (*res.stores.prices.sessions, sessions[260])
            with self.assertRaisesRegex(ValueError, "CUTOFF_VIOLATION"):
                res.stores.assert_cutoff(cutoff_day)
            res.stores.prices.sessions = res.stores.prices.sessions[:-1]

            # 2) Dual-class CIK deduplication kept DUALA (ASSET_1) and dropped lower-dvol DUALB (ASSET_1B)
            self.assertIn(ASSET_1, set(res.anchors.frame["asset_id"]))
            self.assertNotIn(ASSET_1B, set(res.anchors.frame["asset_id"]))
            self.assertGreater(res.report["dedup_dropped_rows"], 0)

            # 3) Labels include Welch beta + GaussRank + dense risk targets, strictly masked when exit > cutoff
            self.assertIn("welch_beta_252d", res.y.columns)
            self.assertIn("h21_gauss_rank", res.y.columns)
            self.assertIn("h21_fwd_rvol", res.y.columns)
            self.assertIn("h21_fwd_max_dd", res.y.columns)
            self.assertIn("h21_fwd_rel_dvol", res.y.columns)
            late_rows = res.anchors.frame["signal_session"] > sessions[229]
            self.assertTrue(res.y.loc[late_rows, "h21_beta_adj_return"].isna().all())
            self.assertTrue(res.y.loc[late_rows, "h21_fwd_rvol"].isna().all())
            self.assertTrue(res.y.loc[late_rows, "h21_fwd_max_dd"].isna().all())

            # 4) peer_spillover works on newly-listed IPO (ASSET_3 active since session 200 -> valid at 235)
            ipo_row = res.anchors.frame[
                (res.anchors.frame["asset_id"] == ASSET_3)
                & (res.anchors.frame["signal_session"] == sessions[235])
            ]
            self.assertEqual(len(ipo_row), 1)
            r_ipo = int(ipo_row.index[0])
            self.assertTrue(np.isfinite(res.X.loc[r_ipo, "peer_spill_ret_5d_63w"]))
            self.assertGreater(float(res.X.loc[r_ipo, "peer_spill_max_corr_63w"]), 0.2)

            # 5) sec_shock_interaction detects unexplained jump on session 220 AND delayed 8-K crash+bounce on 204
            row_220 = res.anchors.frame[
                (res.anchors.frame["asset_id"] == ASSET_1)
                & (res.anchors.frame["signal_session"] == sessions[220])
            ]
            self.assertLess(
                float(res.X.loc[int(row_220.index[0]), "ev_unexplained_jump_1d"]), -3.0
            )

            row_204 = res.anchors.frame[
                (res.anchors.frame["asset_id"] == ASSET_1)
                & (res.anchors.frame["signal_session"] == sessions[204])
            ]
            idx_204 = int(row_204.index[0])
            self.assertLess(float(res.X.loc[idx_204, "sec_shock_exec_z"]), -3.0)
            self.assertGreater(
                float(res.X.loc[idx_204, "sec_shock_exec_recovery"]), 0.05
            )
            self.assertGreaterEqual(
                float(res.X.loc[idx_204, "sec_shock_any_delay_days"]), 3.0
            )

            # 6) macro_sensitivity_crisis is dormant (0.0) when VIX=16 and active when VIX=36, VXV=28
            row_calm = res.anchors.frame[
                (res.anchors.frame["asset_id"] == ASSET_1)
                & (res.anchors.frame["signal_session"] == sessions[200])
            ]
            row_crisis = res.anchors.frame[
                (res.anchors.frame["asset_id"] == ASSET_1)
                & (res.anchors.frame["signal_session"] == sessions[240])
            ]
            self.assertEqual(
                float(res.X.loc[int(row_calm.index[0]), "mac_panic_inversion"]), 0.0
            )
            self.assertEqual(
                float(res.X.loc[int(row_calm.index[0]), "mac_panic_qqq_x"]), 0.0
            )
            self.assertGreater(
                float(res.X.loc[int(row_crisis.index[0]), "mac_panic_inversion"]), 0.0
            )
            self.assertGreater(
                float(res.X.loc[int(row_crisis.index[0]), "mac_beta_qqq_spy_252d"]), 0.5
            )
            self.assertGreater(
                float(res.X.loc[int(row_crisis.index[0]), "mac_panic_qqq_x"]), 0.0
            )


if __name__ == "__main__":
    unittest.main()
