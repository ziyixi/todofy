"""Tests for point-in-time issuer/security market value, splits, and valuation ratios."""

from __future__ import annotations

import math
import unittest
from datetime import date, timedelta
from typing import Any

import numpy as np
import pandas as pd

from research_datasets import (
    VALUATION_NAMES,
    derived_fundamentals,
    normalize_facts,
    valuation,
)
from research_datasets.valuation import _cover_symbol_resolver

ASSET_A = "00000000-0000-4000-8000-000000000001"
ASSET_B = "00000000-0000-4000-8000-000000000002"
ASSET_SINGLE = "00000000-0000-4000-8000-000000000003"
CIK_DUAL = "0000000010"
CIK_SINGLE = "0000000020"


def _business_days(start: str, end: str) -> list[str]:
    cur = date.fromisoformat(start)
    stop = date.fromisoformat(end)
    days: list[str] = []
    while cur <= stop:
        if cur.weekday() < 5:
            days.append(cur.isoformat())
        cur += timedelta(days=1)
    return days


def _fact(
    fact_id: str,
    tag: str,
    value: str,
    period_start: str | None,
    period_end: str,
    *,
    cik: str = CIK_SINGLE,
    taxonomy: str = "us-gaap",
    unit: str = "USD",
    currency: str = "USD",
    form: str = "10-Q",
    period_kind: str = "quarter",
    accession: str = "0000000020-25-000001",
    filed: str = "2025-05-01",
    public_at: str = "2025-05-01T12:00:00Z",
    observed_at: str | None = None,
) -> dict[str, Any]:
    obs = public_at if observed_at is None else observed_at
    return {
        "fact_id": fact_id,
        "cik": cik,
        "metric": tag,
        "source": "sec",
        "taxonomy": taxonomy,
        "tag": tag,
        "tag_priority": 1,
        "unit": unit,
        "currency": currency,
        "value": value,
        "period_start": period_start,
        "period_end": period_end,
        "period_kind": period_kind,
        "form": form,
        "accession": accession,
        "filed": filed,
        "public_at": public_at,
        "public_date": filed,
        "public_time_precision": "second",
        "observed_at": obs,
        "content_first_seen_at": obs,
        "observation_sequence": 1,
        "is_retracted": False,
    }


def _cover_class(
    class_fact_id: str,
    *,
    cik: str = CIK_DUAL,
    accession: str = "0000000010-25-000001",
    filed: str = "2025-05-01",
    public_at: str = "2025-05-01T12:00:00Z",
    as_of_date: str = "2025-04-25",
    class_member: str = "us-gaap:CommonClassAMember",
    trading_symbol: str = "CLSA",
    value: str = "1000000",
) -> dict[str, Any]:
    return {
        "class_fact_id": class_fact_id,
        "cik": cik,
        "accession": accession,
        "form": "10-Q",
        "filed": filed,
        "public_at": public_at,
        "public_date": filed,
        "public_time_precision": "second",
        "as_of_date": as_of_date,
        "class_member": class_member,
        "trading_symbol": trading_symbol,
        "value": value,
        "observed_at": public_at,
        "observation_sequence": 1,
        "is_retracted": False,
    }


def _sample_rows(pairs: list[tuple[str, str, str]]) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "asset_id": aid,
                "signal_session": date.fromisoformat(sig),
                "decision_at": pd.Timestamp(dec),
            }
            for aid, sig, dec in pairs
        ]
    )


class ValuationTest(unittest.TestCase):
    def test_cover_symbol_resolution_preserves_history_and_alias_precedence(
        self,
    ) -> None:
        session = date(2025, 5, 1)
        universe = [
            {"asset_id": ASSET_A, "symbol": "ABC.A"},
            {"asset_id": ASSET_B, "symbol": "ABC-B"},
            {"asset_id": ASSET_SINGLE, "symbol": "ABCA"},
        ]
        history = [
            {
                "asset_id": ASSET_A,
                "symbol": "ABC.A",
                "valid_from": "2025-05-01",
                "valid_to": "2025-05-01",
                "status": "verified",
            },
            {
                "asset_id": ASSET_B,
                "symbol": "ABC.A",
                "valid_from": "",
                "valid_to": "",
                "status": "provisional",
            },
            {
                "asset_id": ASSET_B,
                "symbol": "ABC.B",
                "valid_from": "",
                "valid_to": "",
                "status": "unknown",
            },
        ]
        resolve = _cover_symbol_resolver(universe, history)

        self.assertEqual(resolve(" abc.a ", session), ASSET_A)
        self.assertEqual(resolve("abc.a", session + timedelta(days=1)), ASSET_B)
        self.assertEqual(resolve("abc-b", session), ASSET_B)
        self.assertIsNone(resolve("ABCA", session))
        self.assertEqual(resolve("ABCA", session + timedelta(days=1)), ASSET_B)
        self.assertEqual(
            _cover_symbol_resolver(universe, [])("ABCA", session), ASSET_SINGLE
        )

    def test_dual_class_market_cap_is_issuer_level(self) -> None:
        """Both share classes receive identical issuer market cap and class-specific security cap."""
        cal = _business_days("2025-04-01", "2025-05-30")
        facts = [
            _fact(
                "eq1",
                "StockholdersEquity",
                "50000000",
                None,
                "2025-03-31",
                cik=CIK_DUAL,
                period_kind="instant",
            ),
            _fact(
                "ni1",
                "NetIncomeLoss",
                "10000000",
                "2024-04-01",
                "2025-03-31",
                cik=CIK_DUAL,
                form="10-K",
                period_kind="annual",
            ),
        ]
        share_classes = pd.DataFrame(
            [
                _cover_class(
                    "c_a",
                    cik=CIK_DUAL,
                    class_member="us-gaap:CommonClassAMember",
                    trading_symbol="BRK.A",
                    value="1000",
                ),
                _cover_class(
                    "c_b",
                    cik=CIK_DUAL,
                    class_member="us-gaap:CommonClassBMember",
                    trading_symbol="BRK-B",
                    value="2000000",
                ),
            ]
        )
        raw_prices = pd.DataFrame(
            [
                {"asset_id": ASSET_A, "date": "2025-05-05", "close": 600000.0},
                {"asset_id": ASSET_B, "date": "2025-05-05", "close": 400.0},
            ]
        )
        material = {
            "manifest": {
                "calendar": cal,
                "source_timezones": {"sec": "America/New_York"},
            },
            "universe": pd.DataFrame(
                [
                    {
                        "asset_id": ASSET_A,
                        "symbol": "BRKA",
                        "cik": CIK_DUAL,
                        "issuer_mapping_status": "verified",
                    },
                    {
                        "asset_id": ASSET_B,
                        "symbol": "BRKB",
                        "cik": CIK_DUAL,
                        "issuer_mapping_status": "verified",
                    },
                ]
            ),
            "fundamentals": pd.DataFrame(facts),
            "share_classes": share_classes,
            "raw": raw_prices,
        }
        samples = _sample_rows(
            [
                (ASSET_A, "2025-05-05", "2025-05-06T10:00:00Z"),
                (ASSET_B, "2025-05-05", "2025-05-06T10:00:00Z"),
            ]
        )
        res = valuation(
            material, samples, time_policy="public_reconstructed", provenance=True
        )
        # 1,000 * 600,000 + 2,000,000 * 400 = 600,000,000 + 800,000,000 = 1,400,000,000
        expected_issuer = 1_400_000_000.0
        self.assertAlmostEqual(res.loc[0, "market_cap_issuer_value"], expected_issuer)
        self.assertAlmostEqual(res.loc[1, "market_cap_issuer_value"], expected_issuer)
        self.assertEqual(res.loc[0, "market_cap_issuer_status"], "ok")
        self.assertEqual(res.loc[1, "market_cap_issuer_status"], "ok")
        self.assertEqual(res.loc[0, "market_cap_issuer_basis"], "class_sum")

        self.assertAlmostEqual(res.loc[0, "market_cap_security_value"], 600_000_000.0)
        self.assertAlmostEqual(res.loc[1, "market_cap_security_value"], 800_000_000.0)
        self.assertEqual(res.loc[0, "market_cap_security_status"], "ok")
        self.assertEqual(res.loc[1, "market_cap_security_status"], "ok")

        # Ratios use issuer market cap identically across both share classes
        self.assertAlmostEqual(
            res.loc[0, "book_to_market_value"], 50_000_000.0 / expected_issuer
        )
        self.assertAlmostEqual(
            res.loc[1, "book_to_market_value"], 50_000_000.0 / expected_issuer
        )
        self.assertAlmostEqual(
            res.loc[0, "earnings_yield_value"], 10_000_000.0 / expected_issuer
        )
        self.assertAlmostEqual(
            res.loc[1, "earnings_yield_value"], 10_000_000.0 / expected_issuer
        )

    def test_two_listed_classes_with_different_prices(self) -> None:
        """Symbol carry-back from a newer filing resolves pre-2019 cover rows without symbols."""
        cal = _business_days("2018-04-01", "2020-06-01")
        share_classes = pd.DataFrame(
            [
                # Older filing without trading_symbol
                _cover_class(
                    "old_a",
                    cik=CIK_DUAL,
                    accession="0000000010-18-000001",
                    filed="2018-05-01",
                    public_at="2018-05-01T12:00:00Z",
                    as_of_date="2018-04-20",
                    class_member="us-gaap:CommonClassAMember",
                    trading_symbol="",
                    value="200",
                ),
                _cover_class(
                    "old_b",
                    cik=CIK_DUAL,
                    accession="0000000010-18-000001",
                    filed="2018-05-01",
                    public_at="2018-05-01T12:00:00Z",
                    as_of_date="2018-04-20",
                    class_member="us-gaap:CommonClassBMember",
                    trading_symbol="",
                    value="500",
                ),
                # Later filing with trading_symbol on same class_member
                _cover_class(
                    "new_a",
                    cik=CIK_DUAL,
                    accession="0000000010-20-000001",
                    filed="2020-05-01",
                    public_at="2020-05-01T12:00:00Z",
                    as_of_date="2020-04-20",
                    class_member="us-gaap:CommonClassAMember",
                    trading_symbol="SYMA",
                    value="210",
                ),
                _cover_class(
                    "new_b",
                    cik=CIK_DUAL,
                    accession="0000000010-20-000001",
                    filed="2020-05-01",
                    public_at="2020-05-01T12:00:00Z",
                    as_of_date="2020-04-20",
                    class_member="us-gaap:CommonClassBMember",
                    trading_symbol="SYMB",
                    value="520",
                ),
            ]
        )
        material = {
            "manifest": {
                "calendar": cal,
                "source_timezones": {"sec": "America/New_York"},
            },
            "universe": pd.DataFrame(
                [
                    {
                        "asset_id": ASSET_A,
                        "symbol": "SYMA",
                        "cik": CIK_DUAL,
                        "issuer_mapping_status": "verified",
                    },
                    {
                        "asset_id": ASSET_B,
                        "symbol": "SYMB",
                        "cik": CIK_DUAL,
                        "issuer_mapping_status": "verified",
                    },
                ]
            ),
            "fundamentals": pd.DataFrame(),
            "share_classes": share_classes,
            "raw": pd.DataFrame(
                [
                    {"asset_id": ASSET_A, "date": "2018-05-10", "close": 100.0},
                    {"asset_id": ASSET_B, "date": "2018-05-10", "close": 50.0},
                ]
            ),
        }
        samples = _sample_rows([(ASSET_A, "2018-05-10", "2018-05-11T10:00:00Z")])
        res = valuation(material, samples, time_policy="public_reconstructed")
        # Uses 2018 shares (200 and 500), NOT 2020 shares, mapped via carried-back symbols:
        # 200 * 100 + 500 * 50 = 45,000
        self.assertAlmostEqual(res.loc[0, "market_cap_issuer_value"], 45_000.0)
        self.assertAlmostEqual(res.loc[0, "market_cap_security_value"], 20_000.0)

    def test_class_sum_listed_and_unlisted_classes(self) -> None:
        """Listed classes plus unlisted super-voting class converts 1:1 at Class A price with approximate."""
        cal = _business_days("2025-04-01", "2025-05-30")
        share_classes = pd.DataFrame(
            [
                _cover_class(
                    "ca",
                    cik=CIK_DUAL,
                    class_member="us-gaap:CommonClassAMember",
                    trading_symbol="ALPA",
                    value="300",
                ),
                _cover_class(
                    "cc",
                    cik=CIK_DUAL,
                    class_member="us-gaap:CommonClassCMember",
                    trading_symbol="ALPC",
                    value="400",
                ),
                _cover_class(
                    "cb_unlisted",
                    cik=CIK_DUAL,
                    class_member="us-gaap:CommonClassBMember",
                    trading_symbol="",
                    value="50",
                ),
            ]
        )
        material = {
            "manifest": {
                "calendar": cal,
                "source_timezones": {"sec": "America/New_York"},
            },
            "universe": pd.DataFrame(
                [
                    {
                        "asset_id": ASSET_A,
                        "symbol": "ALPA",
                        "cik": CIK_DUAL,
                        "issuer_mapping_status": "verified",
                    },
                    {
                        "asset_id": ASSET_B,
                        "symbol": "ALPC",
                        "cik": CIK_DUAL,
                        "issuer_mapping_status": "verified",
                    },
                ]
            ),
            "fundamentals": pd.DataFrame(),
            "share_classes": share_classes,
            "raw": pd.DataFrame(
                [
                    {"asset_id": ASSET_A, "date": "2025-05-05", "close": 150.0},
                    {"asset_id": ASSET_B, "date": "2025-05-05", "close": 152.0},
                ]
            ),
        }
        samples = _sample_rows([(ASSET_A, "2025-05-05", "2025-05-06T10:00:00Z")])
        res = valuation(
            material, samples, time_policy="public_reconstructed", provenance=True
        )
        # 300 * 150 + 400 * 152 + 50 * 150 (Class A primary) = 45000 + 60800 + 7500 = 113300
        self.assertAlmostEqual(res.loc[0, "market_cap_issuer_value"], 113_300.0)
        self.assertEqual(res.loc[0, "market_cap_issuer_status"], "approximate")
        self.assertEqual(res.loc[0, "market_cap_issuer_basis"], "class_sum")
        self.assertAlmostEqual(res.loc[0, "market_cap_security_value"], 45_000.0)
        self.assertEqual(res.loc[0, "market_cap_security_status"], "ok")

    def test_security_market_cap_needs_class_rows_for_multi_security_issuer(
        self,
    ) -> None:
        cal = _business_days("2025-04-01", "2025-05-30")
        facts_dual = [
            _fact(
                "sh_dual",
                "EntityCommonStockSharesOutstanding",
                "1000",
                None,
                "2025-04-20",
                cik=CIK_DUAL,
                taxonomy="dei",
                unit="shares",
                currency="",
                period_kind="instant",
            ),
            _fact(
                "sh_single",
                "EntityCommonStockSharesOutstanding",
                "1000",
                None,
                "2025-04-20",
                cik=CIK_SINGLE,
                taxonomy="dei",
                unit="shares",
                currency="",
                period_kind="instant",
            ),
        ]
        material = {
            "manifest": {
                "calendar": cal,
                "source_timezones": {"sec": "America/New_York"},
            },
            "universe": pd.DataFrame(
                [
                    {
                        "asset_id": ASSET_A,
                        "symbol": "DUALA",
                        "cik": CIK_DUAL,
                        "issuer_mapping_status": "verified",
                    },
                    {
                        "asset_id": ASSET_B,
                        "symbol": "DUALB",
                        "cik": CIK_DUAL,
                        "issuer_mapping_status": "verified",
                    },
                    {
                        "asset_id": ASSET_SINGLE,
                        "symbol": "SOLO",
                        "cik": CIK_SINGLE,
                        "issuer_mapping_status": "verified",
                    },
                ]
            ),
            "fundamentals": pd.DataFrame(facts_dual),
            "raw": pd.DataFrame(
                [
                    {"asset_id": ASSET_A, "date": "2025-05-05", "close": 50.0},
                    {"asset_id": ASSET_B, "date": "2025-05-05", "close": 50.0},
                    {"asset_id": ASSET_SINGLE, "date": "2025-05-05", "close": 80.0},
                ]
            ),
        }
        samples = _sample_rows(
            [
                (ASSET_A, "2025-05-05", "2025-05-06T10:00:00Z"),
                (ASSET_SINGLE, "2025-05-05", "2025-05-06T10:00:00Z"),
            ]
        )
        res = valuation(material, samples, time_policy="public_reconstructed")
        self.assertEqual(
            res.loc[0, "market_cap_security_status"], "class_shares_unavailable"
        )
        self.assertTrue(np.isnan(res.loc[0, "market_cap_security_value"]))
        self.assertEqual(res.loc[1, "market_cap_security_status"], "ok")
        self.assertAlmostEqual(
            res.loc[1, "market_cap_security_value"],
            res.loc[1, "market_cap_issuer_value"],
        )

    def test_split_between_cover_date_and_signal_scales_shares(self) -> None:
        """2:1 split between cover share date and signal session keeps market cap continuous."""
        cal = _business_days("2025-04-01", "2025-05-30")
        facts = [
            _fact(
                "sh_cover",
                "EntityCommonStockSharesOutstanding",
                "1000000",
                None,
                "2025-04-25",
                cik=CIK_SINGLE,
                taxonomy="dei",
                unit="shares",
                currency="",
                period_kind="instant",
                filed="2025-05-01",
                public_at="2025-05-01T12:00:00Z",
            )
        ]
        material = {
            "manifest": {
                "calendar": cal,
                "source_timezones": {"sec": "America/New_York"},
            },
            "universe": pd.DataFrame(
                [
                    {
                        "asset_id": ASSET_SINGLE,
                        "symbol": "SOLO",
                        "cik": CIK_SINGLE,
                        "issuer_mapping_status": "verified",
                    }
                ]
            ),
            "fundamentals": pd.DataFrame(facts),
            "corporate_actions": pd.DataFrame(
                [
                    {
                        "action_uid": "act-split-1",
                        "asset_id": ASSET_SINGLE,
                        "role": "subject",
                        "type": "forward_split",
                        "effect_date": "2025-05-12",
                        "split_ratio": 2.0,
                        "observation_sequence": 1,
                        "status": "present",
                    }
                ]
            ),
            "raw": pd.DataFrame(
                [
                    {"asset_id": ASSET_SINGLE, "date": "2025-05-09", "close": 200.0},
                    {"asset_id": ASSET_SINGLE, "date": "2025-05-12", "close": 100.0},
                ]
            ),
        }
        samples = _sample_rows(
            [
                (ASSET_SINGLE, "2025-05-09", "2025-05-12T10:00:00Z"),
                (ASSET_SINGLE, "2025-05-12", "2025-05-13T10:00:00Z"),
            ]
        )
        res = valuation(
            material, samples, time_policy="public_reconstructed", provenance=True
        )
        self.assertAlmostEqual(res.loc[0, "market_cap_issuer_value"], 200_000_000.0)
        self.assertAlmostEqual(res.loc[1, "market_cap_issuer_value"], 200_000_000.0)
        self.assertEqual(res.loc[0, "market_cap_issuer_status"], "ok")
        self.assertEqual(res.loc[1, "market_cap_issuer_status"], "ok")
        self.assertAlmostEqual(res.loc[0, "valuation_split_factor"], 1.0)
        self.assertAlmostEqual(res.loc[1, "valuation_split_factor"], 2.0)

    def test_stock_dividend_ratio_status_across_effect_date(self) -> None:
        material = {
            "manifest": {"calendar": _business_days("2025-05-01", "2025-05-16")},
            "universe": pd.DataFrame(
                [
                    {
                        "asset_id": ASSET_SINGLE,
                        "symbol": "SOLO",
                        "cik": CIK_SINGLE,
                        "issuer_mapping_status": "verified",
                    }
                ]
            ),
            "fundamentals": pd.DataFrame(
                [
                    _fact(
                        "shares",
                        "EntityCommonStockSharesOutstanding",
                        "1000000",
                        None,
                        "2025-05-01",
                        taxonomy="dei",
                        unit="shares",
                        currency="",
                        period_kind="instant",
                    )
                ]
            ),
            "raw": pd.DataFrame(
                [
                    {"asset_id": ASSET_SINGLE, "date": day, "close": 100.0}
                    for day in ("2025-05-09", "2025-05-12")
                ]
            ),
        }
        samples = _sample_rows(
            [
                (ASSET_SINGLE, "2025-05-09", "2025-05-12T10:00:00Z"),
                (ASSET_SINGLE, "2025-05-12", "2025-05-13T10:00:00Z"),
            ]
        )
        cases = (
            ("actions-v2", 1.0, None, 1.0, "split_unverified"),
            ("actions-v1", 1.05, 2.05, 1.0, "split_unverified"),
            ("actions-v1", 0.05, 1.05, 1.05, "ok"),
            ("actions-v2", 1.05, 1.05, 1.05, "ok"),
            (None, None, 1.05, 1.05, "ok"),
        )
        for version, rate, ratio, factor, status in cases:
            with self.subTest(version=version, rate=rate, ratio=ratio):
                material["corporate_actions"] = pd.DataFrame(
                    [
                        {
                            "asset_id": ASSET_SINGLE,
                            "role": "subject",
                            "type": "stock_dividend",
                            "effect_date": "2025-05-12",
                            "normalizer_version": version,
                            "rate": rate,
                            "split_ratio": ratio,
                        }
                    ]
                )
                res = valuation(
                    material,
                    samples,
                    time_policy="public_reconstructed",
                    provenance=True,
                )
                for name in ("market_cap_issuer", "market_cap_security"):
                    self.assertEqual(res[f"{name}_status"].tolist(), ["ok", status])
                    np.testing.assert_allclose(
                        res[f"{name}_value"], [1e8, 1e8 * factor]
                    )
                np.testing.assert_allclose(res["valuation_split_factor"], [1.0, factor])

    def test_statement_eps_reference_date_is_filing_date(self) -> None:
        """ASC 260 statement EPS/shares use filing date as split reference, whereas cover shares use period_end."""
        facts = pd.DataFrame(
            [
                _fact(
                    "cover",
                    "EntityCommonStockSharesOutstanding",
                    "1000",
                    None,
                    "2025-04-20",
                    taxonomy="dei",
                    unit="shares",
                    currency="",
                    period_kind="instant",
                    filed="2025-05-05",
                    public_at="2025-05-05T12:00:00Z",
                ),
                _fact(
                    "bs_sh",
                    "CommonStockSharesOutstanding",
                    "980",
                    None,
                    "2025-03-31",
                    taxonomy="us-gaap",
                    unit="shares",
                    currency="",
                    period_kind="instant",
                    filed="2025-05-05",
                    public_at="2025-05-05T12:00:00Z",
                ),
                _fact(
                    "eps",
                    "EarningsPerShareDiluted",
                    "1.25",
                    "2025-01-01",
                    "2025-03-31",
                    taxonomy="us-gaap",
                    unit="USD/shares",
                    currency="USD",
                    period_kind="quarter",
                    filed="2025-05-05",
                    public_at="2025-05-05T12:00:00Z",
                ),
            ]
        )
        norm, _ = normalize_facts(
            facts,
            time_policy="public_reconstructed",
            source_timezones={"sec": "America/New_York"},
        )
        by_concept = {item.concept: item.reference_date for item in norm}
        self.assertEqual(by_concept["shares_outstanding_cover"], date(2025, 4, 20))
        self.assertEqual(by_concept["shares_outstanding_bs"], date(2025, 5, 5))
        self.assertEqual(by_concept["eps_diluted"], date(2025, 5, 5))

    def test_ratios_use_issuer_market_cap_and_period_alignment(self) -> None:
        """All 14 valuation outputs compute cleanly including debt-free approximate EV and split-adjusted net_issuance_1y."""
        cal = _business_days("2024-04-01", "2025-05-30")
        facts = [
            # Prior year cover shares (1000 pre-split -> 2000 post 2:1 split)
            _fact(
                "sh_24",
                "EntityCommonStockSharesOutstanding",
                "1000",
                None,
                "2024-04-24",
                taxonomy="dei",
                unit="shares",
                currency="",
                period_kind="instant",
                accession="0000000020-24-000001",
                filed="2024-05-01",
                public_at="2024-05-01T12:00:00Z",
            ),
            # Current cover shares after 2:1 split + 10% issuance = 2200
            _fact(
                "sh_25",
                "EntityCommonStockSharesOutstanding",
                "2200",
                None,
                "2025-04-25",
                taxonomy="dei",
                unit="shares",
                currency="",
                period_kind="instant",
                accession="0000000020-25-000001",
                filed="2025-05-01",
                public_at="2025-05-01T12:00:00Z",
            ),
            _fact(
                "eq",
                "StockholdersEquity",
                "44000",
                None,
                "2025-03-31",
                period_kind="instant",
            ),
            _fact(
                "cash",
                "CashAndCashEquivalentsAtCarryingValue",
                "20000",
                None,
                "2025-03-31",
                period_kind="instant",
            ),
            _fact(
                "rev",
                "Revenues",
                "100000",
                "2024-04-01",
                "2025-03-31",
                form="10-K",
                period_kind="annual",
            ),
            _fact(
                "ebit",
                "OperatingIncomeLoss",
                "25000",
                "2024-04-01",
                "2025-03-31",
                form="10-K",
                period_kind="annual",
            ),
            _fact(
                "ni",
                "NetIncomeLoss",
                "22000",
                "2024-04-01",
                "2025-03-31",
                form="10-K",
                period_kind="annual",
            ),
            _fact(
                "ocf",
                "NetCashProvidedByUsedInOperatingActivities",
                "30000",
                "2024-04-01",
                "2025-03-31",
                form="10-K",
                period_kind="annual",
            ),
            _fact(
                "capex",
                "PaymentsToAcquirePropertyPlantAndEquipment",
                "8000",
                "2024-04-01",
                "2025-03-31",
                form="10-K",
                period_kind="annual",
            ),
            _fact(
                "div",
                "PaymentsOfDividendsCommonStock",
                "4400",
                "2024-04-01",
                "2025-03-31",
                form="10-K",
                period_kind="annual",
            ),
            _fact(
                "rep",
                "PaymentsForRepurchaseOfCommonStock",
                "6600",
                "2024-04-01",
                "2025-03-31",
                form="10-K",
                period_kind="annual",
            ),
            _fact(
                "iss",
                "ProceedsFromIssuanceOfCommonStock",
                "2200",
                "2024-04-01",
                "2025-03-31",
                form="10-K",
                period_kind="annual",
            ),
        ]
        material = {
            "manifest": {
                "calendar": cal,
                "source_timezones": {"sec": "America/New_York"},
            },
            "universe": pd.DataFrame(
                [
                    {
                        "asset_id": ASSET_SINGLE,
                        "symbol": "SOLO",
                        "cik": CIK_SINGLE,
                        "issuer_mapping_status": "verified",
                    }
                ]
            ),
            "fundamentals": pd.DataFrame(facts),
            "raw": pd.DataFrame(
                [{"asset_id": ASSET_SINGLE, "date": "2025-05-05", "close": 100.0}]
            ),
        }
        samples = _sample_rows([(ASSET_SINGLE, "2025-05-05", "2025-05-06T10:00:00Z")])
        split_events = pd.DataFrame(
            [
                {
                    "asset_id": ASSET_SINGLE,
                    "ex_date": "2024-09-10",
                    "ratio_new_per_old": 2.0,
                    "status": "ok",
                }
            ]
        )
        derived = derived_fundamentals(
            material, samples, time_policy="public_reconstructed"
        )
        res = valuation(
            material,
            samples,
            derived,
            time_policy="public_reconstructed",
            split_events=split_events,
        )
        for name in VALUATION_NAMES:
            self.assertIn(f"{name}_value", res.columns)
            self.assertIn(f"{name}_status", res.columns)

        # market_cap_issuer = 2200 * 100 = 220,000
        mcap = 220_000.0
        self.assertAlmostEqual(res.loc[0, "market_cap_issuer_value"], mcap)
        self.assertAlmostEqual(res.loc[0, "log_market_cap_value"], math.log(mcap))
        self.assertAlmostEqual(res.loc[0, "book_to_market_value"], 44_000.0 / mcap)
        self.assertAlmostEqual(res.loc[0, "earnings_yield_value"], 22_000.0 / mcap)
        self.assertAlmostEqual(res.loc[0, "sales_yield_value"], 100_000.0 / mcap)
        self.assertAlmostEqual(res.loc[0, "cfo_yield_value"], 30_000.0 / mcap)
        self.assertAlmostEqual(res.loc[0, "fcf_yield_value"], 22_000.0 / mcap)
        self.assertAlmostEqual(res.loc[0, "dividend_yield_value"], 4_400.0 / mcap)
        # net_payout = 4400 + 6600 - 2200 = 8800
        self.assertAlmostEqual(res.loc[0, "net_payout_yield_value"], 8_800.0 / mcap)
        # Debt never reported -> 0 with status approximate; EV = 220,000 + 0 - 20,000 = 200,000
        self.assertAlmostEqual(res.loc[0, "enterprise_value_value"], 200_000.0)
        self.assertEqual(res.loc[0, "enterprise_value_status"], "approximate")
        self.assertAlmostEqual(res.loc[0, "ev_to_sales_value"], 2.0)
        self.assertEqual(res.loc[0, "ev_to_sales_status"], "approximate")
        self.assertAlmostEqual(res.loc[0, "ev_to_ebit_value"], 8.0)
        # net_issuance_1y: 2200 / (1000 * 2.0) - 1 = 0.10
        self.assertAlmostEqual(res.loc[0, "net_issuance_1y_value"], 0.10)
        self.assertEqual(res.loc[0, "net_issuance_1y_status"], "ok")

    def test_non_usd_statements_are_fx_unavailable(self) -> None:
        cal = _business_days("2025-04-01", "2025-05-30")
        facts = [
            _fact(
                "sh",
                "EntityCommonStockSharesOutstanding",
                "1000",
                None,
                "2025-04-20",
                taxonomy="dei",
                unit="shares",
                currency="",
                period_kind="instant",
            ),
            _fact(
                "eq_eur",
                "Equity",
                "50000",
                None,
                "2025-03-31",
                taxonomy="ifrs-full",
                unit="EUR",
                currency="EUR",
                form="20-F",
                period_kind="instant",
            ),
        ]
        material = {
            "manifest": {
                "calendar": cal,
                "source_timezones": {"sec": "America/New_York"},
            },
            "universe": pd.DataFrame(
                [
                    {
                        "asset_id": ASSET_SINGLE,
                        "symbol": "FORN",
                        "cik": CIK_SINGLE,
                        "issuer_mapping_status": "verified",
                    }
                ]
            ),
            "fundamentals": pd.DataFrame(facts),
            "raw": pd.DataFrame(
                [{"asset_id": ASSET_SINGLE, "date": "2025-05-05", "close": 100.0}]
            ),
        }
        samples = _sample_rows([(ASSET_SINGLE, "2025-05-05", "2025-05-06T10:00:00Z")])
        res_no_fx = valuation(material, samples, time_policy="public_reconstructed")
        self.assertEqual(res_no_fx.loc[0, "market_cap_issuer_status"], "ok")
        self.assertEqual(res_no_fx.loc[0, "book_to_market_status"], "fx_unavailable")
        self.assertTrue(np.isnan(res_no_fx.loc[0, "book_to_market_value"]))

        fx = pd.DataFrame(
            [{"currency": "EUR", "date": "2025-05-05", "rate_to_usd": 1.10}]
        )
        res_fx = valuation(material, samples, time_policy="public_reconstructed", fx=fx)
        self.assertEqual(res_fx.loc[0, "book_to_market_status"], "ok")
        self.assertAlmostEqual(
            res_fx.loc[0, "book_to_market_value"], 55_000.0 / 100_000.0
        )

    def test_missing_price_and_stale_shares(self) -> None:
        cal = _business_days("2024-01-01", "2025-06-30")
        facts = [
            _fact(
                "sh",
                "EntityCommonStockSharesOutstanding",
                "1000",
                None,
                "2024-04-01",
                taxonomy="dei",
                unit="shares",
                currency="",
                period_kind="instant",
                filed="2024-04-15",
                public_at="2024-04-15T12:00:00Z",
            )
        ]
        material = {
            "manifest": {
                "calendar": cal,
                "source_timezones": {"sec": "America/New_York"},
            },
            "universe": pd.DataFrame(
                [
                    {
                        "asset_id": ASSET_SINGLE,
                        "symbol": "SOLO",
                        "cik": CIK_SINGLE,
                        "issuer_mapping_status": "verified",
                    }
                ]
            ),
            "fundamentals": pd.DataFrame(facts),
            "raw": pd.DataFrame(
                [
                    {"asset_id": ASSET_SINGLE, "date": "2024-05-01", "close": 50.0},
                    # Bar on 2025-05-05 when shares are > 200 days old
                    {"asset_id": ASSET_SINGLE, "date": "2025-05-05", "close": 60.0},
                ]
            ),
        }
        samples = _sample_rows(
            [
                # > 5 sessions after 2024-05-01 with no bar -> price_unavailable
                (ASSET_SINGLE, "2024-05-20", "2024-05-21T10:00:00Z"),
                # Bar exists on 2025-05-05, but shares from 2024-04-01 are > 200d old -> stale
                (ASSET_SINGLE, "2025-05-05", "2025-05-06T10:00:00Z"),
            ]
        )
        res = valuation(material, samples, time_policy="public_reconstructed")
        self.assertEqual(res.loc[0, "market_cap_issuer_status"], "price_unavailable")
        self.assertEqual(res.loc[1, "market_cap_issuer_status"], "stale")

    def test_split_inferred_from_vendor_bars_is_flagged(self) -> None:
        """Without structured actions, a 2x step in all/raw flags valuation as split_unverified."""
        cal = _business_days("2025-04-01", "2025-05-30")
        facts = [
            _fact(
                "sh",
                "EntityCommonStockSharesOutstanding",
                "1000",
                None,
                "2025-04-25",
                taxonomy="dei",
                unit="shares",
                currency="",
                period_kind="instant",
                filed="2025-05-01",
                public_at="2025-05-01T12:00:00Z",
            )
        ]
        material = {
            "manifest": {
                "calendar": cal,
                "source_timezones": {"sec": "America/New_York"},
            },
            "universe": pd.DataFrame(
                [
                    {
                        "asset_id": ASSET_SINGLE,
                        "symbol": "SOLO",
                        "cik": CIK_SINGLE,
                        "issuer_mapping_status": "verified",
                    }
                ]
            ),
            "fundamentals": pd.DataFrame(facts),
            "raw": pd.DataFrame(
                [
                    {"asset_id": ASSET_SINGLE, "date": "2025-04-25", "close": 200.0},
                    {"asset_id": ASSET_SINGLE, "date": "2025-05-15", "close": 100.0},
                ]
            ),
            "all": pd.DataFrame(
                [
                    # Backward-adjusted pre-split close is 100 -> all/raw = 0.5 at ref, 1.0 post-split
                    {"asset_id": ASSET_SINGLE, "date": "2025-04-25", "close": 100.0},
                    {"asset_id": ASSET_SINGLE, "date": "2025-05-15", "close": 100.0},
                ]
            ),
        }
        samples = _sample_rows([(ASSET_SINGLE, "2025-05-15", "2025-05-16T10:00:00Z")])
        res = valuation(
            material, samples, time_policy="public_reconstructed", provenance=True
        )
        self.assertAlmostEqual(res.loc[0, "market_cap_issuer_value"], 200_000.0)
        self.assertEqual(res.loc[0, "market_cap_issuer_status"], "split_unverified")
        self.assertEqual(res.loc[0, "valuation_split_basis"], "vendor_bars")


if __name__ == "__main__":
    unittest.main()
