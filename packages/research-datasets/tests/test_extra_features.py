"""Synthetic unit tests for reference, alternative, ETF, and universe SDK features."""

from __future__ import annotations

import math
import tempfile
import unittest
import warnings
from datetime import date, timedelta
from typing import Any

import pandas as pd

import research_datasets
from research_datasets import (
    DEFAULT_EXTRA_GROUPS,
    EXTRA_GROUPS,
    REFERENCE_ETFS,
    REFERENCE_SERIES,
    DatasetError,
    asof_join,
    borrow_features,
    build_candidates,
    extra_features,
    factor_matrix,
    forward_returns,
    insider_features,
    market_etf_features,
    reference_features,
    risk_free_daily,
    short_interest_features,
    text_change_features,
)
from tests import test_sdk as fixture

ASSET_1 = "11111111-1111-4111-8111-111111111111"
ASSET_2 = "22222222-2222-4222-8222-222222222222"
ASSET_3 = "33333333-3333-4333-8333-333333333333"
ASSET_4 = "44444444-4444-4444-8444-444444444444"
ASSET_SPY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ASSET_IWB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
ASSET_IWM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
ASSET_RSP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
ASSET_IWD = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
ASSET_IWF = "ffffffff-ffff-4fff-8fff-ffffffffffff"

CIK_1 = "0000100001"
CIK_2 = "0000100002"
CIK_3 = "0000100003"


def _nyse_sessions(start: date, count: int) -> list[date]:
    days: list[date] = []
    cur = start
    while len(days) < count:
        holidays = research_datasets.nyse_holidays(cur.year)
        if cur.weekday() < 5 and cur not in holidays:
            days.append(cur)
        cur += timedelta(days=1)
    return days


def _midnight_et_utc_iso(day: date) -> str:
    ts = pd.Timestamp(day).tz_localize("America/New_York").tz_convert("UTC")
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def _decision_utc(entry_day: date) -> pd.Timestamp:
    return (
        pd.Timestamp(entry_day)
        .tz_localize("America/New_York")
        .replace(hour=6, minute=0, second=0)
        .tz_convert("UTC")
    )


class SyntheticVersion:
    """In-memory frozen Dataset double for fast, deterministic feature tests."""

    def __init__(
        self,
        *,
        calendar: list[date],
        universe: list[dict[str, Any]],
        families: dict[str, pd.DataFrame] | None = None,
        prices_adj: pd.DataFrame | None = None,
        prices_raw: pd.DataFrame | None = None,
        manifest_extra: dict[str, Any] | None = None,
    ) -> None:
        self.id = "99999999-9999-4999-8999-999999999999"
        self.manifest_sha256 = "a" * 64
        self._calendar = [d.isoformat() for d in calendar]
        self._universe = universe
        self._families = families or {}
        self._prices_adj = prices_adj if prices_adj is not None else pd.DataFrame()
        self._prices_raw = prices_raw if prices_raw is not None else pd.DataFrame()
        data_families: dict[str, dict[str, Any]] = {
            name: {
                "schema_version": 1,
                "rows": len(df),
                **({"evaluation_only": True} if name == "factor_returns" else {}),
            }
            for name, df in self._families.items()
        }
        self.manifest: dict[str, Any] = {
            "dataset_id": self.id,
            "schema_version": 3,
            "cutoff_date": self._calendar[-1],
            "calendar": list(self._calendar),
            "universe": list(universe),
            "data_families": data_families,
            "limitations": [],
            **(manifest_extra or {}),
        }

    @property
    def calendar(self) -> list[str]:
        return list(self._calendar)

    @property
    def universe(self) -> pd.DataFrame:
        return pd.DataFrame(self._universe)

    def resolve(self, symbols: Any = None) -> list[str]:
        if symbols is None or symbols == "all":
            return [str(u["asset_id"]) for u in self._universe]
        known = {str(u["asset_id"]) for u in self._universe}
        items = [symbols] if isinstance(symbols, str) else list(symbols)
        out: list[str] = []
        for item in items:
            if item in known:
                out.append(str(item))
                continue
            matches = [
                u
                for u in self._universe
                if str(u.get("symbol", "")).upper() == str(item).upper()
            ]
            if not matches:
                raise DatasetError("SYMBOL_NOT_FOUND", f"Missing {item}")
            active = [
                u for u in matches if str(u.get("status", "active")).lower() == "active"
            ]
            chosen = active[0] if len(active) == 1 else matches[0]
            out.append(str(chosen["asset_id"]))
        return out

    def prices(
        self, symbols: Any = None, *, adjusted: bool = True, **_: Any
    ) -> pd.DataFrame:
        df = self._prices_adj if adjusted else self._prices_raw
        if df.empty or symbols is None or symbols == "all":
            return df.copy()
        ids = set(self.resolve(symbols))
        return df[df["asset_id"].astype(str).isin(ids)].reset_index(drop=True)

    def family(
        self,
        name: str,
        symbols: Any = None,
        start: Any = None,
        end: Any = None,
        *,
        columns: Any = None,
    ) -> pd.DataFrame:
        if name not in self._families:
            raise DatasetError("CAPABILITY_MISSING", f"Missing {name}")
        df = self._families[name].copy()
        spec = research_datasets.FAMILY_SPECS[name]
        if symbols is not None and symbols != "all" and not df.empty:
            if spec.identity == "asset_id" and "asset_id" in df.columns:
                ids = set(self.resolve(symbols))
                df = df[df["asset_id"].astype(str).isin(ids)]
            elif spec.identity == "series_id" and "series_id" in df.columns:
                sids = {
                    s.upper()
                    for s in ([symbols] if isinstance(symbols, str) else list(symbols))
                }
                df = df[df["series_id"].astype(str).str.upper().isin(sids)]
            elif spec.identity == "cik":
                ids = set(self.resolve(symbols))
                ciks = {
                    str(u.get("cik", "")).zfill(10)
                    for u in self._universe
                    if str(u["asset_id"]) in ids and u.get("cik")
                }
                cik_col = "issuer_cik" if "issuer_cik" in df.columns else "cik"
                if cik_col in df.columns and ciks:
                    df = df[df[cik_col].astype(str).str.zfill(10).isin(ciks)]
        if columns is not None and not df.empty:
            df = df[list(columns)].copy()
        df = df.reset_index(drop=True)
        df.attrs["family"] = name
        df.attrs["dataset_version"] = self.id
        return df


def _make_candidates(sessions: list[date], asset_ids: list[str]) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for aid in asset_ids:
        for idx in range(len(sessions) - 1):
            rows.append(
                {
                    "asset_id": aid,
                    "signal_session": sessions[idx],
                    "entry_session": sessions[idx + 1],
                    "decision_at": _decision_utc(sessions[idx + 1]),
                    "in_universe": True,
                    "is_benchmark": False,
                }
            )
    return pd.DataFrame(rows)


class ExtraFeaturesTest(unittest.TestCase):
    def test_constants_and_version(self) -> None:
        self.assertEqual(research_datasets.__version__, "2.3.0")
        self.assertEqual(len(REFERENCE_SERIES), 36)
        self.assertEqual(len(REFERENCE_ETFS), 19)
        self.assertEqual(
            EXTRA_GROUPS,
            (
                "reference",
                "market_etf",
                "insider",
                "short_interest",
                "text_change",
                "borrow",
            ),
        )
        self.assertEqual(DEFAULT_EXTRA_GROUPS, EXTRA_GROUPS[:-1])

    def test_reference_features_one_session_lag_and_age_limit(self) -> None:
        sessions = _nyse_sessions(date(2026, 1, 2), 40)
        # Observation d on sessions[i] becomes public at midnight ET after sessions[i + 1].
        ref_rows: list[dict[str, Any]] = []
        for idx in range(25):
            obs_day = sessions[idx]
            c1_day = sessions[idx + 1]
            avail = _midnight_et_utc_iso(c1_day + timedelta(days=1))
            ref_rows.extend(
                [
                    {
                        "series_id": "DTB3",
                        "date": obs_day.isoformat(),
                        "value": 4.0 + 0.01 * idx,
                        "observation_sequence": 1,
                        "observed_at": avail,
                        "available_at": avail,
                    },
                    {
                        "series_id": "DGS3MO",
                        "date": obs_day.isoformat(),
                        "value": 4.10 + 0.01 * idx,
                        "observation_sequence": 1,
                        "observed_at": avail,
                        "available_at": avail,
                    },
                    {
                        "series_id": "DGS2",
                        "date": obs_day.isoformat(),
                        "value": 4.20 + 0.01 * idx,
                        "observation_sequence": 1,
                        "observed_at": avail,
                        "available_at": avail,
                    },
                    {
                        "series_id": "DGS10",
                        "date": obs_day.isoformat(),
                        "value": 4.50 + 0.02 * idx,
                        "observation_sequence": 1,
                        "observed_at": avail,
                        "available_at": avail,
                    },
                    {
                        "series_id": "VIXCLS",
                        "date": obs_day.isoformat(),
                        "value": 18.0 + 0.5 * idx,
                        "observation_sequence": 1,
                        "observed_at": avail,
                        "available_at": avail,
                    },
                    {
                        "series_id": "VXVCLS",
                        "date": obs_day.isoformat(),
                        "value": 20.0 + 0.5 * idx,
                        "observation_sequence": 1,
                        "observed_at": avail,
                        "available_at": avail,
                    },
                    {
                        "series_id": "DTWEXBGS",
                        "date": obs_day.isoformat(),
                        "value": 110.0 + idx,
                        "observation_sequence": 1,
                        "observed_at": avail,
                        "available_at": avail,
                    },
                    {
                        "series_id": "DCOILWTICO",
                        # Negative price at idx == 23 tests non-positive log-return guard.
                        "date": obs_day.isoformat(),
                        "value": -5.0 if idx == 23 else 70.0 + idx,
                        "observation_sequence": 1,
                        "observed_at": avail,
                        "available_at": avail,
                    },
                ]
            )

        version = SyntheticVersion(
            calendar=sessions,
            universe=[{"asset_id": ASSET_1, "symbol": "AAA", "status": "active"}],
            families={"reference_series": pd.DataFrame(ref_rows)},
        )
        cands = _make_candidates(sessions, [ASSET_1])
        feats = reference_features(version, cands, time_policy="public_reconstructed")

        # On signal session sessions[0] (decision at 06:00 ET on sessions[1]),
        # sessions[0]'s observation (available midnight after sessions[1]) is NOT yet usable.
        self.assertTrue(pd.isna(feats.loc[0, "ref_rf_3m"]))
        self.assertTrue(pd.isna(feats.loc[0, "ref_age_days"]))

        # On signal session sessions[1] (decision at 06:00 ET on sessions[2]),
        # sessions[0]'s observation IS usable (one-session lag).
        self.assertAlmostEqual(feats.loc[1, "ref_rf_3m"], 0.04, places=8)
        self.assertAlmostEqual(feats.loc[1, "ref_term_10y_3m"], (4.50 - 4.10) / 100.0)
        self.assertAlmostEqual(feats.loc[1, "ref_vix_term"], 18.0 / 20.0)

        # At signal session sessions[22] (decision on sessions[23]), usable rows are idx 0..21 (22 rows):
        # 21-row change compares idx 21 vs idx 0.
        self.assertAlmostEqual(
            feats.loc[22, "ref_d10y_21d"], ((4.50 + 0.02 * 21) - 4.50) / 100.0
        )
        self.assertAlmostEqual(
            feats.loc[22, "ref_usd_ret_21d"], math.log((110.0 + 21) / 110.0)
        )

        # Negative oil price at idx == 23 (usable on signal session sessions[24]) produces NaN log return.
        self.assertTrue(pd.isna(feats.loc[24, "ref_oil_ret_21d"]))

        # Last observation is sessions[24]; more than 10 calendar days later (sessions[35]), all float values turn NaN.
        self.assertGreater(int(feats.loc[35, "ref_age_days"]), 10)
        self.assertTrue(pd.isna(feats.loc[35, "ref_rf_3m"]))
        self.assertTrue(pd.isna(feats.loc[35, "ref_vix"]))

    def test_market_etf_spreads_use_closes_through_signal_session(self) -> None:
        sessions = _nyse_sessions(date(2026, 1, 2), 70)
        etfs = [
            (ASSET_SPY, "SPY", 1.001),
            (ASSET_IWB, "IWB", 1.0012),
            (ASSET_IWM, "IWM", 1.002),
            (ASSET_RSP, "RSP", 1.0015),
            (ASSET_IWD, "IWD", 1.0018),
            (ASSET_IWF, "IWF", 1.0008),
        ]
        universe = [{"asset_id": ASSET_1, "symbol": "AAA", "status": "active"}] + [
            {
                "asset_id": aid,
                "symbol": sym,
                "status": "active",
                "security_type": "etf",
                "is_benchmark": True,
            }
            for aid, sym, _ in etfs
        ]
        dr_rows: list[dict[str, Any]] = []
        for idx, day in enumerate(sessions):
            for aid, _, growth in etfs:
                # Inject a massive 50% jump on the final session (entry session for idx 68)
                # to verify signal session 68 never peeks at session 69's close!
                mult = 1.5 if idx == 69 else 1.0
                dr_rows.append(
                    {
                        "asset_id": aid,
                        "date": day.isoformat(),
                        "tr_index": 100.0 * (growth**idx) * mult,
                    }
                )

        version = SyntheticVersion(
            calendar=sessions,
            universe=universe,
            families={"daily_returns": pd.DataFrame(dr_rows)},
            manifest_extra={
                "reference": {"reference_etfs": [sym for _, sym, _ in etfs]}
            },
        )
        cands = _make_candidates(sessions, [ASSET_1])
        feats = market_etf_features(version, cands, time_policy="public_reconstructed")

        # Row 68 has signal_session = sessions[68] and entry_session = sessions[69] (where the 1.5x jump happens).
        row68 = feats.loc[68]
        self.assertAlmostEqual(row68["etf_mkt_ret_21d"], (1.001**21) - 1.0, places=9)
        self.assertAlmostEqual(row68["etf_mkt_ret_63d"], (1.001**63) - 1.0, places=9)
        self.assertAlmostEqual(
            row68["etf_size_ret_63d"], (1.002**63 - 1.0) - (1.0012**63 - 1.0), places=9
        )
        self.assertAlmostEqual(
            row68["etf_breadth_ret_63d"],
            (1.0015**63 - 1.0) - (1.001**63 - 1.0),
            places=9,
        )
        self.assertAlmostEqual(
            row68["etf_value_ret_63d"],
            (1.0018**63 - 1.0) - (1.0008**63 - 1.0),
            places=9,
        )

    def test_insider_windows_and_document_type_filter(self) -> None:
        sessions = _nyse_sessions(date(2026, 7, 1), 5)
        decision_day = sessions[1]  # 2026-07-02
        # Cover full 180-day window via 2026q1 and 2026q2 dataset checks plus July 1 daily check.
        checks = pd.DataFrame(
            [
                {
                    "source": "sec_insider_dataset",
                    "unit_key": "2026q1",
                    "status": "checked",
                    "checked_at": "2026-04-15T00:00:00Z",
                },
                {
                    "source": "sec_insider_dataset",
                    "unit_key": "2026q2",
                    "status": "checked",
                    "checked_at": "2026-07-01T12:00:00Z",
                },
                {
                    "source": "sec_insider_daily",
                    "unit_key": "2026-07-01",
                    "status": "checked",
                    "scope_ciks": [CIK_1],
                    "checked_at": "2026-07-02T01:00:00Z",
                },
            ]
        )
        tx = pd.DataFrame(
            [
                # Recent Form 4 buy (30 days ago -> in both 90d and 180d windows), officer=True.
                {
                    "accession": "0000100001-26-000001",
                    "issuer_cik": CIK_1,
                    "document_type": "4",
                    "filing_date": "2026-06-01",
                    "available_at": _midnight_et_utc_iso(date(2026, 6, 2)),
                    "observed_at": _midnight_et_utc_iso(date(2026, 6, 2)),
                    "owner_ciks": ["0000900001"],
                    "any_officer": True,
                    "seq": 1,
                    "trans_code": "P",
                    "acq_disp": "A",
                    "shares": 1000.0,
                    "price": 50.0,
                },
                # Form 4 buy with NULL price (counts filing & buyer, excluded from dollar value).
                {
                    "accession": "0000100001-26-000002",
                    "issuer_cik": CIK_1,
                    "document_type": "4",
                    "filing_date": "2026-06-10",
                    "available_at": _midnight_et_utc_iso(date(2026, 6, 11)),
                    "observed_at": _midnight_et_utc_iso(date(2026, 6, 11)),
                    "owner_ciks": ["0000900002"],
                    "any_officer": False,
                    "seq": 1,
                    "trans_code": "P",
                    "acq_disp": "A",
                    "shares": 500.0,
                    "price": None,
                },
                # Older Form 4 sell (120 days ago -> in 180d window ONLY, not 90d).
                {
                    "accession": "0000100001-26-000003",
                    "issuer_cik": CIK_1,
                    "document_type": "4",
                    "filing_date": "2026-03-02",
                    "available_at": _midnight_et_utc_iso(date(2026, 3, 3)),
                    "observed_at": _midnight_et_utc_iso(date(2026, 3, 3)),
                    "owner_ciks": ["0000900003"],
                    "any_officer": False,
                    "seq": 1,
                    "trans_code": "S",
                    "acq_disp": "D",
                    "shares": 500.0,
                    "price": 60.0,
                },
                # Form 4/A and Form 5 must be EXCLUDED even inside 90d window!
                {
                    "accession": "0000100001-26-000004",
                    "issuer_cik": CIK_1,
                    "document_type": "4/A",
                    "filing_date": "2026-06-15",
                    "available_at": _midnight_et_utc_iso(date(2026, 6, 16)),
                    "observed_at": _midnight_et_utc_iso(date(2026, 6, 16)),
                    "owner_ciks": ["0000900009"],
                    "any_officer": True,
                    "seq": 1,
                    "trans_code": "P",
                    "acq_disp": "A",
                    "shares": 9999.0,
                    "price": 100.0,
                },
                {
                    "accession": "0000100001-26-000005",
                    "issuer_cik": CIK_1,
                    "document_type": "5",
                    "filing_date": "2026-06-16",
                    "available_at": _midnight_et_utc_iso(date(2026, 6, 17)),
                    "observed_at": _midnight_et_utc_iso(date(2026, 6, 17)),
                    "owner_ciks": ["0000900008"],
                    "any_officer": True,
                    "seq": 1,
                    "trans_code": "P",
                    "acq_disp": "A",
                    "shares": 8888.0,
                    "price": 100.0,
                },
            ]
        )
        version = SyntheticVersion(
            calendar=sessions,
            universe=[
                {
                    "asset_id": ASSET_1,
                    "symbol": "AAA",
                    "status": "active",
                    "cik": CIK_1,
                    "issuer_mapping_status": "verified",
                }
            ],
            families={"insider_transactions": tx, "reference_checks": checks},
        )
        cands = _make_candidates(sessions[:2], [ASSET_1])
        self.assertEqual(cands.loc[0, "entry_session"], decision_day)
        fund = pd.DataFrame(
            {"market_cap_issuer_value": [1_000_000.0]}, index=cands.index
        )
        res = insider_features(
            version, cands, time_policy="public_reconstructed", fundamentals=fund
        )

        self.assertEqual(res.loc[0, "ins_coverage"], "covered")
        # 90d window: 2 buy filings, 2 buyers, 0 sellers, buy_value = 50,000, sell_value = 0.
        self.assertEqual(res.loc[0, "ins_buy_filings_90d"], 2.0)
        self.assertEqual(res.loc[0, "ins_buyers_90d"], 2.0)
        self.assertEqual(res.loc[0, "ins_sellers_90d"], 0.0)
        self.assertAlmostEqual(res.loc[0, "ins_buy_value_90d"], 50_000.0)
        self.assertAlmostEqual(res.loc[0, "ins_sell_value_90d"], 0.0)
        self.assertAlmostEqual(res.loc[0, "ins_net_ratio_90d"], 1.0)
        self.assertAlmostEqual(res.loc[0, "ins_net_value_mcap_90d"], 0.05)
        self.assertTrue(bool(res.loc[0, "ins_officer_buy_90d"]))

        # 180d window includes the 120d-ago sell of $30,000 -> net_ratio = (50k - 30k) / (50k + 30k) = 0.25.
        self.assertEqual(res.loc[0, "ins_sellers_180d"], 1.0)
        self.assertAlmostEqual(res.loc[0, "ins_sell_value_180d"], 30_000.0)
        self.assertAlmostEqual(res.loc[0, "ins_net_ratio_180d"], 0.25)
        self.assertAlmostEqual(res.loc[0, "ins_net_value_mcap_180d"], 0.02)

    def test_insider_coverage_nan_when_window_not_covered(self) -> None:
        sessions = _nyse_sessions(date(2026, 7, 1), 4)
        # Only 2026q2 is checked (~50% of 180d weekdays < 95%), and ASSET_2 has no CIK.
        checks = pd.DataFrame(
            [
                {
                    "source": "sec_insider_dataset",
                    "unit_key": "2026q2",
                    "status": "checked",
                    "checked_at": "2026-07-01T00:00:00Z",
                }
            ]
        )
        tx = pd.DataFrame(
            [
                {
                    "accession": "0000100001-26-000001",
                    "issuer_cik": CIK_1,
                    "document_type": "4",
                    "filing_date": "2026-06-01",
                    "available_at": _midnight_et_utc_iso(date(2026, 6, 2)),
                    "observed_at": _midnight_et_utc_iso(date(2026, 6, 2)),
                    "owner_ciks": ["0000900001"],
                    "any_officer": True,
                    "seq": 1,
                    "trans_code": "P",
                    "acq_disp": "A",
                    "shares": 100.0,
                    "price": 20.0,
                }
            ]
        )
        version = SyntheticVersion(
            calendar=sessions,
            universe=[
                {
                    "asset_id": ASSET_1,
                    "symbol": "AAA",
                    "status": "active",
                    "cik": CIK_1,
                    "issuer_mapping_status": "verified",
                },
                {
                    "asset_id": ASSET_2,
                    "symbol": "BBB",
                    "status": "active",
                    "cik": None,
                    "issuer_mapping_status": "unmapped",
                },
            ],
            families={"insider_transactions": tx, "reference_checks": checks},
        )
        cands = _make_candidates(sessions[:2], [ASSET_1, ASSET_2])
        res = insider_features(version, cands, time_policy="public_reconstructed")
        self.assertEqual(res.loc[0, "ins_coverage"], "partial")
        self.assertEqual(res.loc[1, "ins_coverage"], "issuer_unmapped")
        self.assertTrue(pd.isna(res.loc[0, "ins_buy_filings_90d"]))
        self.assertTrue(pd.isna(res.loc[0, "ins_buy_value_180d"]))
        self.assertTrue(pd.isna(res.loc[0, "ins_officer_buy_90d"]))
        self.assertTrue(pd.isna(res.loc[1, "ins_buy_filings_90d"]))

    def test_short_interest_before_archive_is_nan_with_label(self) -> None:
        sessions = _nyse_sessions(date(2017, 12, 26), 16)
        # First archive settlement 2017-12-29 becomes available at midnight ET after 8th session (2018-01-12T05:00:00Z).
        si = pd.DataFrame(
            [
                {
                    "asset_id": ASSET_1,
                    "link_basis": "symbol_interval",
                    "symbol": "AAA",
                    "settlement_date": "2017-12-29",
                    "current_short": 200_000.0,
                    "previous_short": 160_000.0,
                    "days_to_cover": 2.5,
                    "split_flag": "",
                    "observation_sequence": 1,
                    "observed_at": "2018-01-12T05:00:00Z",
                    "available_at": "2018-01-12T05:00:00Z",
                }
            ]
        )
        version = SyntheticVersion(
            calendar=sessions,
            universe=[{"asset_id": ASSET_1, "symbol": "AAA", "status": "active"}],
            families={"short_interest": si},
        )
        cands = _make_candidates(sessions, [ASSET_1])
        res = short_interest_features(
            version, cands, time_policy="public_reconstructed"
        )

        # Decisions before 2018-01-12 06:00 ET are labeled before_archive with NaN values.
        early = res[cands["entry_session"] < date(2018, 1, 12)]
        self.assertTrue((early["si_coverage"] == "before_archive").all())
        self.assertTrue(early["si_shares"].isna().all())
        self.assertTrue(early["si_age_sessions"].isna().all())

        # On entry_session 2018-01-12 (06:00 ET >= 00:00 ET), coverage becomes covered.
        live = res[cands["entry_session"] == date(2018, 1, 12)].iloc[0]
        self.assertEqual(live["si_coverage"], "covered")
        self.assertAlmostEqual(live["si_shares"], 200_000.0)
        self.assertAlmostEqual(live["si_change"], 0.25)

    def test_short_interest_split_flag_masks_change(self) -> None:
        sessions = _nyse_sessions(date(2026, 1, 14), 15)
        si = pd.DataFrame(
            [
                {
                    "asset_id": ASSET_1,
                    "link_basis": "symbol_interval",
                    "symbol": "AAA",
                    "settlement_date": "2026-01-15",
                    "current_short": 400_000.0,
                    "previous_short": 100_000.0,
                    "days_to_cover": 3.0,
                    "split_flag": "S",
                    "observation_sequence": 1,
                    "observed_at": "2026-01-29T05:00:00Z",
                    "available_at": "2026-01-29T05:00:00Z",
                }
            ]
        )
        version = SyntheticVersion(
            calendar=sessions,
            universe=[{"asset_id": ASSET_1, "symbol": "AAA", "status": "active"}],
            families={"short_interest": si},
        )
        cands = _make_candidates(sessions, [ASSET_1])
        fund = pd.DataFrame(
            {"shares_outstanding_value": [10_000_000.0] * len(cands)},
            index=cands.index,
        )
        res = short_interest_features(
            version, cands, time_policy="public_reconstructed", fundamentals=fund
        )
        usable = res[cands["entry_session"] >= date(2026, 1, 29)].iloc[0]
        self.assertEqual(usable["si_coverage"], "covered")
        self.assertTrue(bool(usable["si_split_flag"]))
        self.assertAlmostEqual(usable["si_shares"], 400_000.0)
        self.assertAlmostEqual(usable["si_pct_shares"], 0.04)
        self.assertTrue(pd.isna(usable["si_change"]))

    def test_unverified_link_excluded_by_default(self) -> None:
        sessions = _nyse_sessions(date(2026, 1, 28), 4)
        si = pd.DataFrame(
            [
                {
                    "asset_id": ASSET_1,
                    "link_basis": "current_symbol_unverified",
                    "symbol": "AAA",
                    "settlement_date": "2026-01-15",
                    "current_short": 150_000.0,
                    "previous_short": 100_000.0,
                    "days_to_cover": 1.8,
                    "split_flag": "",
                    "observation_sequence": 1,
                    "observed_at": "2026-01-29T05:00:00Z",
                    "available_at": "2026-01-29T05:00:00Z",
                }
            ]
        )
        version = SyntheticVersion(
            calendar=sessions,
            universe=[{"asset_id": ASSET_1, "symbol": "AAA", "status": "active"}],
            families={"short_interest": si},
        )
        cands = _make_candidates(sessions, [ASSET_1])
        strict_res = short_interest_features(
            version, cands, time_policy="public_reconstructed"
        )
        self.assertTrue((strict_res["si_coverage"] == "unlinked").all())
        self.assertTrue(strict_res["si_shares"].isna().all())

        opt_in_res = short_interest_features(
            version,
            cands,
            time_policy="public_reconstructed",
            allow_unverified_links=True,
        )
        row = opt_in_res[cands["entry_session"] >= date(2026, 1, 29)].iloc[0]
        self.assertEqual(row["si_coverage"], "covered")
        self.assertAlmostEqual(row["si_shares"], 150_000.0)

    def test_text_change_latest_filing_and_age_limit(self) -> None:
        # Build sessions covering a 10-K in Feb 2025, a 10-Q in May 2025, and a stale check >200d later in Jan 2026.
        sessions = [
            date(2025, 6, 2),
            date(2025, 6, 3),
            date(2026, 1, 5),
            date(2026, 1, 6),
            date(2026, 4, 20),
            date(2026, 4, 21),
        ]
        txt_rows = [
            # 10-K filed 2025-02-20
            {
                "cik": CIK_1,
                "accession": "acc-10k",
                "form": "10-K",
                "filing_date": "2025-02-20",
                "section": "full",
                "status": "ok",
                "cosine": 0.88,
                "jaccard": 0.72,
                "length_log_ratio": 0.05,
                "computed_at": "2025-02-20T22:00:00Z",
                "available_at": "2025-02-20T21:30:00Z",
            },
            {
                "cik": CIK_1,
                "accession": "acc-10k",
                "form": "10-K",
                "filing_date": "2025-02-20",
                "section": "risk_factors",
                "status": "ok",
                "cosine": 0.84,
                "jaccard": 0.65,
                "length_log_ratio": 0.03,
                "computed_at": "2025-02-20T22:00:00Z",
                "available_at": "2025-02-20T21:30:00Z",
            },
            {
                "cik": CIK_1,
                "accession": "acc-10k",
                "form": "10-K",
                "filing_date": "2025-02-20",
                "section": "mdna",
                "status": "ok",
                "cosine": 0.80,
                "jaccard": 0.60,
                "length_log_ratio": 0.02,
                "computed_at": "2025-02-20T22:00:00Z",
                "available_at": "2025-02-20T21:30:00Z",
            },
            # 10-Q filed 2025-05-10
            {
                "cik": CIK_1,
                "accession": "acc-10q",
                "form": "10-Q",
                "filing_date": "2025-05-10",
                "section": "full",
                "status": "ok",
                "cosine": 0.93,
                "jaccard": 0.81,
                "length_log_ratio": -0.02,
                "computed_at": "2025-05-10T20:00:00Z",
                "available_at": "2025-05-10T19:00:00Z",
            },
            {
                "cik": CIK_1,
                "accession": "acc-10q",
                "form": "10-Q",
                "filing_date": "2025-05-10",
                "section": "risk_factors",
                "status": "section_missing",
                "cosine": None,
                "jaccard": None,
                "length_log_ratio": None,
                "computed_at": "2025-05-10T20:00:00Z",
                "available_at": "2025-05-10T19:00:00Z",
            },
            {
                "cik": CIK_1,
                "accession": "acc-10q",
                "form": "10-Q",
                "filing_date": "2025-05-10",
                "section": "mdna",
                "status": "ok",
                "cosine": 0.90,
                "jaccard": 0.77,
                "length_log_ratio": -0.01,
                "computed_at": "2025-05-10T20:00:00Z",
                "available_at": "2025-05-10T19:00:00Z",
            },
        ]
        version = SyntheticVersion(
            calendar=sessions,
            universe=[
                {
                    "asset_id": ASSET_1,
                    "symbol": "AAA",
                    "status": "active",
                    "cik": CIK_1,
                    "issuer_mapping_status": "verified",
                }
            ],
            families={"text_changes": pd.DataFrame(txt_rows)},
        )
        cands = pd.DataFrame(
            [
                {
                    "asset_id": ASSET_1,
                    "signal_session": sessions[0],
                    "decision_at": _decision_utc(sessions[1]),
                },
                {
                    "asset_id": ASSET_1,
                    "signal_session": sessions[2],
                    "decision_at": _decision_utc(sessions[3]),
                },
                {
                    "asset_id": ASSET_1,
                    "signal_session": sessions[4],
                    "decision_at": _decision_utc(sessions[5]),
                },
            ]
        )
        res = text_change_features(version, cands, time_policy="public_reconstructed")

        # Row 0 (2025-06-03): latest filing is 10-Q (24d old <= 200d), while txt_sim_full_10k comes from 10-K (0.88).
        self.assertEqual(res.loc[0, "txt_form"], "10-Q")
        self.assertEqual(res.loc[0, "txt_status"], "ok")
        self.assertAlmostEqual(res.loc[0, "txt_sim_full"], 0.93)
        self.assertTrue(pd.isna(res.loc[0, "txt_sim_rf"]))
        self.assertAlmostEqual(res.loc[0, "txt_sim_mdna"], 0.90)
        self.assertAlmostEqual(res.loc[0, "txt_sim_full_10k"], 0.88)

        # Row 1 (2026-01-06): 10-Q is 241 days old (> 200d -> NaN), 10-K is 320 days old (<= 400d -> still 0.88).
        self.assertGreater(int(res.loc[1, "txt_age_days"]), 200)
        self.assertTrue(pd.isna(res.loc[1, "txt_sim_full"]))
        self.assertTrue(pd.isna(res.loc[1, "txt_sim_mdna"]))
        self.assertAlmostEqual(res.loc[1, "txt_sim_full_10k"], 0.88)

        # Row 2 (2026-04-21): 10-K is > 400 days old -> txt_sim_full_10k also becomes NaN.
        self.assertTrue(pd.isna(res.loc[2, "txt_sim_full_10k"]))

    def test_factor_returns_refused_by_asof_join(self) -> None:
        sessions = _nyse_sessions(date(2026, 1, 2), 4)
        fr = pd.DataFrame(
            [
                {
                    "factor_set": "ff5_daily",
                    "date": sessions[0].isoformat(),
                    "factor": "Mkt-RF",
                    "value": 0.005,
                    "vintage_id": "0123456789abcdef",
                    "source_note": "CRSP 202601",
                    "retrieved_at": "2026-03-01T00:00:00Z",
                },
                {
                    "factor_set": "ff5_daily",
                    "date": sessions[0].isoformat(),
                    "factor": "SMB",
                    "value": -0.002,
                    "vintage_id": "0123456789abcdef",
                    "source_note": "CRSP 202601",
                    "retrieved_at": "2026-03-01T00:00:00Z",
                },
            ]
        )
        version = SyntheticVersion(
            calendar=sessions,
            universe=[{"asset_id": ASSET_1, "symbol": "AAA", "status": "active"}],
            families={"factor_returns": fr},
        )
        table = version.family("factor_returns")
        cands = _make_candidates(sessions[:2], [ASSET_1]).assign(factor="Mkt-RF")
        table_with_clock = table.assign(available_at="2026-01-03T00:00:00Z")
        table_with_clock.attrs.update(table.attrs)

        with self.assertRaisesRegex(ValueError, "EVALUATION_ONLY"):
            asof_join(
                cands,
                table_with_clock,
                by="factor",
                columns=["value"],
            )
        with self.assertRaisesRegex(ValueError, "EVALUATION_ONLY"):
            asof_join(
                cands,
                fr.assign(available_at="2026-01-03T00:00:00Z"),
                by="factor",
                columns=["value"],
                family="factor_returns",
            )

        # Direct evaluation matrix works cleanly.
        fm = factor_matrix(version, factor_set="ff5_daily")
        self.assertTrue(fm.attrs["evaluation_only"])
        self.assertAlmostEqual(fm.loc[sessions[0], "Mkt-RF"], 0.005)
        self.assertAlmostEqual(fm.loc[sessions[0], "SMB"], -0.002)

    def test_borrow_not_in_default_groups(self) -> None:
        self.assertNotIn("borrow", DEFAULT_EXTRA_GROUPS)
        self.assertIn("borrow", EXTRA_GROUPS)

        sessions = _nyse_sessions(date(2026, 2, 2), 8)
        obs_ts = "2026-02-02T14:00:00Z"
        brw = pd.DataFrame(
            [
                {
                    "asset_id": ASSET_1,
                    "observed_at": obs_ts,
                    "available_at": obs_ts,
                    "shortable": True,
                    "easy_to_borrow": False,
                }
            ]
        )
        version = SyntheticVersion(
            calendar=sessions,
            universe=[{"asset_id": ASSET_1, "symbol": "AAA", "status": "active"}],
            families={"borrow_availability": brw},
        )
        cands = _make_candidates(sessions, [ASSET_1])

        default_df = extra_features(version, cands, time_policy="public_reconstructed")
        self.assertEqual(list(default_df.columns), [])

        opt_in = borrow_features(version, cands, time_policy="public_reconstructed")
        # Entry 2026-02-03 06:00 ET is < 3 days after 2026-02-02T14:00Z -> observed=True.
        self.assertTrue(bool(opt_in.loc[0, "brw_observed"]))
        self.assertTrue(bool(opt_in.loc[0, "brw_shortable"]))
        self.assertFalse(bool(opt_in.loc[0, "brw_easy_to_borrow"]))

        # Entry > 3 days after 2026-02-02T14:00Z -> observed=False, flags <NA>.
        late = opt_in[cands["entry_session"] >= date(2026, 2, 6)].iloc[0]
        self.assertFalse(bool(late["brw_observed"]))
        self.assertTrue(pd.isna(late["brw_shortable"]))
        self.assertTrue(pd.isna(late["brw_easy_to_borrow"]))

    def test_observed_content_delays_backfilled_rows(self) -> None:
        sessions = _nyse_sessions(date(2019, 3, 1), 5)
        avail_2019 = _midnight_et_utc_iso(sessions[1] + timedelta(days=1))
        backfilled_2026 = "2026-11-01T10:00:00Z"
        ref = pd.DataFrame(
            [
                {
                    "series_id": "DTB3",
                    "date": sessions[0].isoformat(),
                    "value": 2.40,
                    "observation_sequence": 1,
                    "observed_at": backfilled_2026,
                    "available_at": avail_2019,
                }
            ]
        )
        si = pd.DataFrame(
            [
                {
                    "asset_id": ASSET_1,
                    "link_basis": "symbol_interval",
                    "symbol": "AAA",
                    "settlement_date": "2019-02-15",
                    "current_short": 50_000.0,
                    "previous_short": 40_000.0,
                    "days_to_cover": 2.0,
                    "split_flag": "",
                    "observation_sequence": 1,
                    "observed_at": backfilled_2026,
                    "available_at": "2019-02-28T05:00:00Z",
                }
            ]
        )
        txt = pd.DataFrame(
            [
                {
                    "cik": CIK_1,
                    "accession": "acc-2019",
                    "form": "10-K",
                    "filing_date": "2019-02-20",
                    "section": "full",
                    "status": "ok",
                    "cosine": 0.91,
                    "jaccard": 0.75,
                    "length_log_ratio": 0.01,
                    "computed_at": backfilled_2026,
                    "available_at": "2019-02-20T21:00:00Z",
                }
            ]
        )
        version = SyntheticVersion(
            calendar=sessions,
            universe=[
                {
                    "asset_id": ASSET_1,
                    "symbol": "AAA",
                    "status": "active",
                    "cik": CIK_1,
                    "issuer_mapping_status": "verified",
                }
            ],
            families={
                "reference_series": ref,
                "short_interest": si,
                "text_changes": txt,
            },
        )
        cands = _make_candidates(sessions, [ASSET_1])

        pub = extra_features(version, cands, time_policy="public_reconstructed")
        obs = extra_features(version, cands, time_policy="observed_content")

        # Usable in 2019 under public_reconstructed, NOT usable in 2019 under observed_content.
        self.assertAlmostEqual(pub.loc[1, "ref_rf_3m"], 0.024)
        self.assertAlmostEqual(pub.loc[1, "si_shares"], 50_000.0)
        self.assertAlmostEqual(pub.loc[1, "txt_sim_full"], 0.91)

        self.assertTrue(obs["ref_rf_3m"].isna().all())
        self.assertTrue(obs["si_shares"].isna().all())
        self.assertEqual(set(obs["si_coverage"]), {"unlinked"})
        self.assertTrue(obs["txt_sim_full"].isna().all())

    def test_missing_families_produce_no_columns_and_attrs_note(self) -> None:
        sessions = _nyse_sessions(date(2026, 1, 2), 4)
        version = SyntheticVersion(
            calendar=sessions,
            universe=[
                {"asset_id": ASSET_1, "symbol": "AAA", "status": "active"},
                {"asset_id": ASSET_SPY, "symbol": "SPY", "status": "active"},
            ],
            families={},
        )
        cands = _make_candidates(sessions, [ASSET_1])
        out = extra_features(
            version,
            cands,
            time_policy="public_reconstructed",
            groups=EXTRA_GROUPS,
        )
        self.assertEqual(len(out), len(cands))
        self.assertEqual(list(out.columns), [])
        self.assertEqual(
            out.attrs["extra_missing"],
            [
                "reference_series",
                "reference_etfs",
                "insider_transactions",
                "short_interest",
                "text_changes",
                "borrow_availability",
            ],
        )

    def test_risk_free_daily_compounding(self) -> None:
        sessions = _nyse_sessions(date(2026, 1, 2), 253)
        # Observation before sessions[0] so sessions[1..252] (252 sessions) all see 5.04%.
        avail = _midnight_et_utc_iso(sessions[1])
        ref = pd.DataFrame(
            [
                {
                    "series_id": "DTB3",
                    "date": sessions[0].isoformat(),
                    "value": 5.04,
                    "observation_sequence": 1,
                    "observed_at": avail,
                    "available_at": avail,
                }
            ]
        )
        version = SyntheticVersion(
            calendar=sessions,
            universe=[{"asset_id": ASSET_1, "symbol": "AAA", "status": "active"}],
            families={"reference_series": ref},
        )
        rf = risk_free_daily(version, series="DTB3")
        self.assertEqual(len(rf), 253)
        # Session 0 at 06:00 ET is after midnight ET on sessions[1]? No, sessions[0] < sessions[1], so NaN on session 0.
        self.assertTrue(pd.isna(rf.iloc[0]))
        usable = rf.iloc[1:]
        self.assertEqual(len(usable), 252)
        compounded = float((1.0 + usable).prod() - 1.0)
        self.assertAlmostEqual(compounded, 0.0504, places=10)

    def test_resolve_prefers_active_holder_of_reused_symbol(self) -> None:
        delisted_old = "55555555-5555-4555-8555-555555555555"
        delisted_older = "66666666-6666-4666-8666-666666666666"
        active_second = "77777777-7777-4777-8777-777777777777"

        # 1 active + 1 inactive sharing "AAPL" -> warns and resolves to active ASSET_A.
        objects, _ = fixture._build_synthetic_bundle()
        import json

        manifest_key = f"datasets/{fixture.DATASET_ID}/manifest.json"
        manifest = json.loads(objects[manifest_key].decode("utf-8"))
        manifest["universe"].extend(
            [
                {
                    "asset_id": delisted_old,
                    "symbol": "AAPL",
                    "exchange": "XNYS",
                    "status": "inactive",
                    "name": "Prior Reused Holder Corp",
                    "cik": None,
                    "issuer_mapping_status": "unmapped",
                },
                # Two inactive holders of "OLDX" with 0 active -> must still raise SYMBOL_AMBIGUOUS.
                {
                    "asset_id": delisted_older,
                    "symbol": "OLDX",
                    "exchange": "XNYS",
                    "status": "inactive",
                    "name": "Old One",
                    "cik": None,
                    "issuer_mapping_status": "unmapped",
                },
                {
                    "asset_id": ASSET_3,
                    "symbol": "OLDX",
                    "exchange": "XNAS",
                    "status": "inactive",
                    "name": "Old Two",
                    "cik": None,
                    "issuer_mapping_status": "unmapped",
                },
                # Two active holders of "DUAL" -> must still raise SYMBOL_AMBIGUOUS.
                {
                    "asset_id": ASSET_4,
                    "symbol": "DUAL",
                    "exchange": "XNYS",
                    "status": "active",
                    "name": "Dual Active One",
                    "cik": None,
                    "issuer_mapping_status": "unmapped",
                },
                {
                    "asset_id": active_second,
                    "symbol": "DUAL",
                    "exchange": "XNAS",
                    "status": "active",
                    "name": "Dual Active Two",
                    "cik": None,
                    "issuer_mapping_status": "unmapped",
                },
            ]
        )
        objects[manifest_key] = json.dumps(manifest).encode("utf-8")

        with (
            fixture.SyntheticDatasetServer(objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = research_datasets.load(
                fixture.DATASET_ID,
                key=fixture.TOKEN,
                base_url=server.base_url,
                cache_dir=tmp,
            )
            with warnings.catch_warnings(record=True) as caught_warnings:
                warnings.simplefilter("always")
                resolved = ds.resolve("AAPL")
            self.assertEqual(resolved, [fixture.ASSET_A])
            self.assertEqual(len(caught_warnings), 1)
            self.assertIs(caught_warnings[0].category, UserWarning)
            self.assertIn(fixture.ASSET_A, str(caught_warnings[0].message))

            for ambig in ("OLDX", "DUAL"):
                with self.assertRaises(DatasetError) as ctx:
                    ds.resolve(ambig)
                self.assertEqual(ctx.exception.reason, "SYMBOL_AMBIGUOUS")

    def test_pit_universe_end_to_end_on_synthetic_membership_and_exits(self) -> None:
        # 12 sessions across Jan and Feb 2026; ASSET_1 stays active, ASSET_2 cash-merges on Feb 4,
        # ASSET_3 performance-delists on Feb 4, and SPY is flagged benchmark (excluded from default candidates).
        sessions = [
            date(2026, 1, 27),
            date(2026, 1, 28),
            date(2026, 1, 29),
            date(2026, 1, 30),
            date(2026, 2, 2),
            date(2026, 2, 3),
            date(2026, 2, 4),
            date(2026, 2, 5),
            date(2026, 2, 6),
            date(2026, 2, 9),
            date(2026, 2, 10),
            date(2026, 2, 11),
        ]
        universe = [
            {
                "asset_id": ASSET_1,
                "symbol": "AAA",
                "status": "active",
                "security_type": "common",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_2,
                "symbol": "MRG",
                "status": "inactive",
                "security_type": "common",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_3,
                "symbol": "PERF",
                "status": "inactive",
                "security_type": "common",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_4,
                "symbol": "ETF1",
                "status": "active",
                "security_type": "etf",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_SPY,
                "symbol": "SPY",
                "status": "active",
                "security_type": "etf",
                "is_benchmark": True,
            },
        ]
        membership = pd.DataFrame(
            [
                {
                    "rule_version": "pit-largecap-v1",
                    "effective_month": "2026-01",
                    "effective_from": "2026-01-02",
                    "asset_id": ASSET_1,
                    "member": True,
                    "warmup": False,
                    "basis": "ranked",
                    "observation_sequence": 1,
                },
                {
                    "rule_version": "pit-largecap-v1",
                    "effective_month": "2026-02",
                    "effective_from": "2026-02-02",
                    "asset_id": ASSET_1,
                    "member": True,
                    "warmup": False,
                    "basis": "ranked",
                    "observation_sequence": 1,
                },
                {
                    "rule_version": "pit-largecap-v1",
                    "effective_month": "2026-02",
                    "effective_from": "2026-02-02",
                    "asset_id": ASSET_2,
                    "member": True,
                    "warmup": False,
                    "basis": "ranked",
                    "observation_sequence": 1,
                },
                {
                    "rule_version": "pit-largecap-v1",
                    "effective_month": "2026-02",
                    "effective_from": "2026-02-02",
                    "asset_id": ASSET_3,
                    "member": True,
                    "warmup": False,
                    "basis": "ranked",
                    "observation_sequence": 1,
                },
            ]
        )
        delistings = pd.DataFrame(
            [
                {
                    "asset_id": ASSET_2,
                    "last_trade_date": "2026-02-03",
                    "exit_session": "2026-02-04",
                    "exit_type": "cash_merger",
                    "successor_asset_id": "",
                    "cash_amount": "125.0",
                    "observed_at": "2026-02-05T00:00:00Z",
                    "observation_sequence": 1,
                },
                {
                    "asset_id": ASSET_3,
                    "last_trade_date": "2026-02-03",
                    "exit_session": "2026-02-04",
                    "exit_type": "performance",
                    "successor_asset_id": "",
                    "cash_amount": "",
                    "observed_at": "2026-02-05T00:00:00Z",
                    "observation_sequence": 1,
                },
            ]
        )

        price_rows: list[dict[str, Any]] = []
        dr_rows: list[dict[str, Any]] = []
        for idx, d in enumerate(sessions):
            # SPY flat at 500, ASSET_1 grows 1% per session.
            for aid, p0, p in (
                (ASSET_SPY, 500.0, 500.0),
                (ASSET_1, 100.0, 100.0 * (1.01**idx)),
            ):
                price_rows.append(
                    {
                        "asset_id": aid,
                        "date": d.isoformat(),
                        "open": p,
                        "close": p,
                        "volume": 1_000_000.0,
                        "adjustment": "all",
                    }
                )
                dr_rows.append(
                    {
                        "asset_id": aid,
                        "date": d.isoformat(),
                        "row_kind": "first" if idx == 0 else "session",
                        "open_raw": p,
                        "close_raw": p,
                        "tr_index": p / p0,
                        "tr_status": "first" if idx == 0 else "ok",
                        "terminal_basis": "",
                        "cash_amount": 0.0,
                    }
                )
            # ASSET_2 & ASSET_3 trade only through 2026-02-03 (idx <= 5) at 100.0.
            if idx <= 5:
                for aid in (ASSET_2, ASSET_3):
                    price_rows.append(
                        {
                            "asset_id": aid,
                            "date": d.isoformat(),
                            "open": 100.0,
                            "close": 100.0,
                            "volume": 500_000.0,
                            "adjustment": "all",
                        }
                    )
                    dr_rows.append(
                        {
                            "asset_id": aid,
                            "date": d.isoformat(),
                            "row_kind": "first" if idx == 0 else "session",
                            "open_raw": 100.0,
                            "close_raw": 100.0,
                            "tr_index": 1.0,
                            "tr_status": "first" if idx == 0 else "ok",
                            "terminal_basis": "",
                            "cash_amount": 0.0,
                        }
                    )
            elif idx == 6:
                # Terminal cash_merger settlement row on exit_session 2026-02-04 at $125 (+25%).
                dr_rows.append(
                    {
                        "asset_id": ASSET_2,
                        "date": d.isoformat(),
                        "row_kind": "terminal",
                        "open_raw": None,
                        "close_raw": None,
                        "tr_index": 1.25,
                        "tr_status": "terminal",
                        "terminal_basis": "cash",
                        "cash_amount": 125.0,
                    }
                )
                # Terminal performance exit row on exit_session 2026-02-04 (default policy -30%).
                dr_rows.append(
                    {
                        "asset_id": ASSET_3,
                        "date": d.isoformat(),
                        "row_kind": "terminal",
                        "open_raw": None,
                        "close_raw": None,
                        "tr_index": float("nan"),
                        "tr_status": "terminal",
                        "terminal_basis": "unknown",
                        "cash_amount": 0.0,
                    }
                )

        raw_rows = [{**r, "adjustment": "raw"} for r in price_rows]
        version = SyntheticVersion(
            calendar=sessions,
            universe=universe,
            families={
                "universe_membership": membership,
                "delistings": delistings,
                "daily_returns": pd.DataFrame(dr_rows),
            },
            prices_adj=pd.DataFrame(price_rows),
            prices_raw=pd.DataFrame(raw_rows),
            manifest_extra={
                "universe_membership": {
                    "default_rule": "pit-largecap-v1",
                    "months": ["2026-01", "2026-02"],
                }
            },
        )

        cands = build_candidates(version, None, benchmark="SPY")
        # ETF1 and SPY excluded by security_type / is_benchmark; Jan entries keep only ASSET_1; Feb entries include 1, 2, 3.
        self.assertEqual(set(cands["asset_id"]), {ASSET_1, ASSET_2, ASSET_3})
        jan_cands = cands[cands["entry_session"] < date(2026, 2, 1)]
        self.assertEqual(set(jan_cands["asset_id"]), {ASSET_1})

        labels = forward_returns(version, cands, benchmark="SPY", horizons=5)
        # Signal 2026-01-30 -> entry 2026-02-02 (Feb member!), 5d window spans 2026-02-02..2026-02-06 (includes Feb 4 exit).
        mrg_row = labels[
            (labels["asset_id"] == ASSET_2)
            & (labels["signal_session"] == date(2026, 1, 30))
        ].iloc[0]
        self.assertTrue(bool(mrg_row["delisted_in_window"]))
        self.assertEqual(mrg_row["terminal_basis"], "cash")
        self.assertAlmostEqual(mrg_row["asset_return"], 0.25, places=6)

        perf_row = labels[
            (labels["asset_id"] == ASSET_3)
            & (labels["signal_session"] == date(2026, 1, 30))
        ].iloc[0]
        self.assertTrue(bool(perf_row["delisted_in_window"]))
        self.assertEqual(perf_row["terminal_basis"], "policy")
        self.assertAlmostEqual(perf_row["asset_return"], -0.30, places=6)

    def test_bundle_convenience_readers_and_panel_extra_integration(self) -> None:
        sessions = [date.fromisoformat(s) for s in fixture.SESSIONS]
        avail = _midnight_et_utc_iso(sessions[2])
        extra_fams = {
            "index_holdings": [
                {
                    "index_code": "IWB",
                    "report_date": "2025-12-31",
                    "filed_date": sessions[1].isoformat(),
                    "cusip": "037833100",
                    "weight": 0.06,
                }
            ],
            "universe_membership": [
                {
                    "rule_version": "pit-largecap-v1",
                    "effective_month": sessions[0].isoformat()[:7],
                    "effective_from": sessions[0].isoformat(),
                    "asset_id": fixture.ASSET_A,
                    "member": True,
                    "warmup": False,
                    "basis": "ranked",
                    "observation_sequence": 1,
                },
                {
                    "rule_version": "pit-other-v1",
                    "effective_month": sessions[0].isoformat()[:7],
                    "effective_from": sessions[0].isoformat(),
                    "asset_id": fixture.ASSET_G1,
                    "member": True,
                    "warmup": False,
                    "basis": "ranked",
                    "observation_sequence": 1,
                },
            ],
            "delistings": [
                {
                    "asset_id": fixture.ASSET_G2,
                    "last_trade_date": sessions[-2].isoformat(),
                    "exit_session": sessions[-1].isoformat(),
                    "exit_type": "cash_merger",
                    "successor_asset_id": "",
                    "cash_amount": "155.0",
                    "observed_at": f"{sessions[-1].isoformat()}T00:00:00Z",
                    "observation_sequence": 1,
                }
            ],
            "reference_series": [
                {
                    "series_id": "DTB3",
                    "date": sessions[0].isoformat(),
                    "value": 4.5,
                    "observation_sequence": 1,
                    "observed_at": avail,
                    "available_at": avail,
                },
                {
                    "series_id": "DGS10",
                    "date": sessions[0].isoformat(),
                    "value": 4.8,
                    "observation_sequence": 1,
                    "observed_at": avail,
                    "available_at": avail,
                },
            ],
            "short_interest": [
                {
                    "asset_id": aid,
                    "link_basis": "symbol_interval",
                    "symbol": sym,
                    "settlement_date": sessions[0].isoformat(),
                    "current_short": sh,
                    "previous_short": sh * 0.9,
                    "days_to_cover": dtc,
                    "split_flag": "",
                    "observation_sequence": 1,
                    "observed_at": avail,
                    "available_at": avail,
                }
                for aid, sym, sh, dtc in (
                    (fixture.ASSET_A, "AAPL", 1_000_000.0, 1.5),
                    (fixture.ASSET_G1, "GOOG", 2_000_000.0, 3.0),
                )
            ],
        }
        objects, _ = fixture._build_synthetic_bundle(extra_families=extra_fams)
        with (
            fixture.SyntheticDatasetServer(objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = research_datasets.load(
                fixture.DATASET_ID,
                key=fixture.TOKEN,
                base_url=server.base_url,
                cache_dir=tmp,
            )
            # Convenience readers & series_id filter.
            um_all = ds.universe_membership()
            self.assertEqual(len(um_all), 2)
            um_filtered = ds.universe_membership(rule_version="pit-largecap-v1")
            self.assertEqual(um_filtered["asset_id"].tolist(), [fixture.ASSET_A])
            self.assertEqual(len(ds.delistings()), 1)
            self.assertEqual(len(ds.index_holdings()), 1)
            dgs10 = ds.family("reference_series", "DGS10")
            self.assertEqual(dgs10["series_id"].tolist(), ["DGS10"])

            # Cross-sectional ranks on extra_features.
            cands = ds.candidates(
                ["AAPL", "GOOG"],
                universe="static",
                start=ds.calendar[6],
                end=ds.calendar[7],
            )
            ranked = ds.extra_features(
                cands, time_policy="public_reconstructed", ranks=True
            )
            self.assertIn("si_days_to_cover_rank", ranked.columns)
            day6 = ranked[cands["signal_session"] == date.fromisoformat(ds.calendar[6])]
            self.assertEqual(sorted(day6["si_days_to_cover_rank"].tolist()), [0.5, 1.0])

            # panel(include_extra=True) wires fundamentals shares_outstanding into si_pct_shares
            # and records provenance['extra'].
            pnl = ds.panel(
                ["AAPL", "GOOG"],
                start=ds.calendar[6],
                end=ds.calendar[7],
                universe="static",
                allow_static_universe=True,
                time_policy="public_reconstructed",
                horizons=(1, 5),
            )
            self.assertIn("ref_rf_3m", pnl.columns)
            self.assertIn("si_shares", pnl.columns)
            self.assertIn("si_pct_shares", pnl.columns)
            self.assertTrue(pnl["si_pct_shares"].notna().any())
            prov_extra = pnl.attrs["provenance"]["extra"]
            self.assertEqual(prov_extra["groups"], list(DEFAULT_EXTRA_GROUPS))
            self.assertIn("reference_series", prov_extra["families_present"])
            self.assertIn("short_interest", prov_extra["families_present"])
            self.assertIn("si_coverage", prov_extra["coverage_counts"])

            # panel(include_extra=False) omits extra columns cleanly.
            pnl_no_extra = ds.panel(
                ["AAPL", "GOOG"],
                start=ds.calendar[6],
                end=ds.calendar[7],
                universe="static",
                allow_static_universe=True,
                time_policy="public_reconstructed",
                include_extra=False,
                horizons=(1, 5),
            )
            self.assertNotIn("ref_rf_3m", pnl_no_extra.columns)
            self.assertNotIn("si_shares", pnl_no_extra.columns)


if __name__ == "__main__":
    unittest.main()
