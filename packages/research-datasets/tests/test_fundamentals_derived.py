"""Tests for the XBRL concept catalogue, state machine, derived quarters, and family schemas."""

from __future__ import annotations

import tempfile
import unittest
from datetime import date
from typing import Any

import numpy as np
import pandas as pd

import research_datasets
from research_datasets import (
    COMPOSITES,
    CONCEPT_TAGS,
    CONCEPTS,
    TAG_TO_CONCEPT,
    asset_at,
    cik_at,
    derived_fundamentals,
    fiscal_quarters,
    fundamental_factors,
    fundamental_states,
    prepare_fundamental_features,
)
from tests import test_sdk as bundle

ASSET_A = "00000000-0000-4000-8000-000000000001"
ASSET_B = "00000000-0000-4000-8000-000000000002"
CIK = "0000000001"


def make_fact(
    fact_id: str,
    tag: str,
    value: str,
    period_start: str | None,
    period_end: str,
    *,
    cik: str = CIK,
    taxonomy: str = "us-gaap",
    unit: str = "USD",
    currency: str = "USD",
    form: str = "10-Q",
    period_kind: str = "quarter",
    accession: str = "0000000001-25-000001",
    public_at: str = "2025-05-01T12:00:00Z",
    public_date: str | None = None,
    observed_at: str | None = None,
    filed: str | None = None,
    public_time_precision: str = "second",
    observation_sequence: int = 1,
    is_retracted: bool = False,
    metric: str = "",
) -> dict[str, Any]:
    obs = public_at if observed_at is None else observed_at
    pub_day = (
        public_date
        if public_date is not None
        else (public_at[:10] if public_at else "")
    )
    return {
        "fact_id": fact_id,
        "cik": cik,
        "metric": metric or tag,
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
        "filed": filed if filed is not None else pub_day,
        "public_at": public_at,
        "public_date": pub_day,
        "public_time_precision": public_time_precision,
        "observed_at": obs,
        "content_first_seen_at": obs,
        "observation_sequence": observation_sequence,
        "is_retracted": is_retracted,
    }


def make_material(rows: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {
        "manifest": {"source_timezones": {"sec": "America/New_York"}},
        "universe": pd.DataFrame(
            [
                {"asset_id": ASSET_A, "cik": CIK, "issuer_mapping_status": "verified"},
                {"asset_id": ASSET_B, "cik": CIK, "issuer_mapping_status": "verified"},
            ]
        ),
        "fundamentals": pd.DataFrame(rows),
        **extra,
    }


class ConceptCatalogueTest(unittest.TestCase):
    def test_concept_catalogue_contract(self) -> None:
        self.assertEqual(len(CONCEPTS), 63)
        self.assertEqual(len(COMPOSITES), 7)
        seen_tags: set[tuple[str, str]] = set()
        for name, concept in CONCEPTS.items():
            self.assertEqual(name, concept.name)
            self.assertIn(concept.kind, {"duration", "instant"})
            self.assertIn(concept.unit_kind, {"money", "shares", "per_share"})
            self.assertIn(concept.min_parser, {1, 2})
            if concept.kind == "instant":
                self.assertFalse(concept.additive)
            self.assertGreaterEqual(len(concept.tags), 1)
            for tax, tag in concept.tags:
                self.assertIn(tax, {"us-gaap", "dei", "ifrs-full"})
                self.assertNotIn((tax, tag), seen_tags)
                seen_tags.add((tax, tag))
                self.assertIs(CONCEPT_TAGS[(tax, tag)], concept)
                self.assertEqual(TAG_TO_CONCEPT[(tax, tag)], name)
        self.assertEqual(len(CONCEPT_TAGS), len(seen_tags))

        legacy_tags = {
            ("us-gaap", "Revenues"),
            ("us-gaap", "SalesRevenueNet"),
            ("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"),
            ("us-gaap", "RevenueFromContractWithCustomerIncludingAssessedTax"),
            ("us-gaap", "GrossProfit"),
            ("us-gaap", "OperatingIncomeLoss"),
            ("us-gaap", "NetIncomeLoss"),
            ("us-gaap", "ProfitLoss"),
            ("us-gaap", "NetCashProvidedByUsedInOperatingActivities"),
            ("us-gaap", "PaymentsToAcquirePropertyPlantAndEquipment"),
            ("us-gaap", "EarningsPerShareDiluted"),
            ("us-gaap", "WeightedAverageNumberOfSharesOutstandingBasic"),
            ("us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding"),
            ("us-gaap", "CashAndCashEquivalentsAtCarryingValue"),
            ("us-gaap", "Assets"),
            ("us-gaap", "Liabilities"),
            ("us-gaap", "StockholdersEquity"),
            (
                "us-gaap",
                "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
            ),
            ("us-gaap", "CommonStockSharesOutstanding"),
            ("dei", "EntityCommonStockSharesOutstanding"),
        }
        for key in legacy_tags:
            self.assertIn(key, CONCEPT_TAGS)
            self.assertEqual(CONCEPT_TAGS[key].min_parser, 1)


class DerivedQuartersTest(unittest.TestCase):
    def test_cash_flow_quarters_are_derived_not_stuck_at_q1(self) -> None:
        ocf_tag = "NetCashProvidedByUsedInOperatingActivities"
        capex_tag = "PaymentsToAcquirePropertyPlantAndEquipment"
        rows = [
            # Q1 (3M)
            make_fact(
                "ocf-q1",
                ocf_tag,
                "100",
                "2025-01-01",
                "2025-03-31",
                metric="operating_cash_flow",
                period_kind="quarter",
                accession="0001-25-q1",
                public_at="2025-05-02T12:00:00Z",
            ),
            make_fact(
                "capex-q1",
                capex_tag,
                "25",
                "2025-01-01",
                "2025-03-31",
                metric="capex",
                period_kind="quarter",
                accession="0001-25-q1",
                public_at="2025-05-02T12:00:00Z",
            ),
            # H1 (6M YTD only)
            make_fact(
                "ocf-h1",
                ocf_tag,
                "230",
                "2025-01-01",
                "2025-06-30",
                metric="operating_cash_flow",
                period_kind="ytd",
                accession="0001-25-q2",
                public_at="2025-08-04T12:00:00Z",
            ),
            make_fact(
                "capex-h1",
                capex_tag,
                "60",
                "2025-01-01",
                "2025-06-30",
                metric="capex",
                period_kind="ytd",
                accession="0001-25-q2",
                public_at="2025-08-04T12:00:00Z",
            ),
            # 9M (9M YTD only)
            make_fact(
                "ocf-9m",
                ocf_tag,
                "390",
                "2025-01-01",
                "2025-09-30",
                metric="operating_cash_flow",
                period_kind="ytd",
                accession="0001-25-q3",
                public_at="2025-11-03T12:00:00Z",
            ),
            make_fact(
                "capex-9m",
                capex_tag,
                "105",
                "2025-01-01",
                "2025-09-30",
                metric="capex",
                period_kind="ytd",
                accession="0001-25-q3",
                public_at="2025-11-03T12:00:00Z",
            ),
            # FY (12M in 10-K)
            make_fact(
                "ocf-fy",
                ocf_tag,
                "600",
                "2025-01-01",
                "2025-12-31",
                metric="operating_cash_flow",
                period_kind="annual",
                form="10-K",
                accession="0001-26-fy",
                public_at="2026-02-17T12:00:00Z",
            ),
            make_fact(
                "capex-fy",
                capex_tag,
                "155",
                "2025-01-01",
                "2025-12-31",
                metric="capex",
                period_kind="annual",
                form="10-K",
                accession="0001-26-fy",
                public_at="2026-02-17T12:00:00Z",
            ),
        ]
        mat = make_material(rows)
        samples = pd.DataFrame(
            [
                {
                    "asset_id": ASSET_A,
                    "signal_session": "2025-11-10",
                    "decision_at": "2025-11-11T11:00:00Z",
                }
            ]
        )
        derived = derived_fundamentals(
            mat,
            samples,
            time_policy="public_reconstructed",
            views=("operating_cash_flow_q", "fcf_q"),
            provenance=True,
        )
        row = derived.iloc[0]
        self.assertAlmostEqual(row["operating_cash_flow_q_value"], 160.0)
        self.assertEqual(row["operating_cash_flow_q_status"], "ok")
        self.assertEqual(row["operating_cash_flow_q_period_end"], date(2025, 9, 30))
        self.assertEqual(row["operating_cash_flow_q_basis"], "ytd_difference")
        self.assertLess(row["operating_cash_flow_q_age_days"], 60.0)
        self.assertAlmostEqual(row["fcf_q_value"], 115.0)

        # Legacy quarter lookup has no YTD differencing and remains on Q1 (age > 200d).
        legacy = prepare_fundamental_features(
            mat,
            samples,
            metrics={"operating_cash_flow": "USD"},
            period_kind="quarter",
            time_policy="public_reconstructed",
        )
        self.assertEqual(legacy.iloc[0]["operating_cash_flow_period_end"], "2025-03-31")
        self.assertEqual(legacy.iloc[0]["operating_cash_flow_status"], "stale")

    def test_q4_derived_from_fy_minus_nine_months_only_after_10k_clock(self) -> None:
        # Accepted Friday after 17:30 New York; SEC filingDate is Monday 2026-02-23,
        # so public instant is 2026-02-23 06:00 ET (11:00:00Z).
        rows = [
            make_fact(
                "rev-q1",
                "Revenues",
                "100",
                "2025-01-01",
                "2025-03-31",
                accession="acc-q1",
                public_at="2025-05-01T12:00:00Z",
            ),
            make_fact(
                "rev-h1",
                "Revenues",
                "220",
                "2025-01-01",
                "2025-06-30",
                accession="acc-q2",
                public_at="2025-08-01T12:00:00Z",
            ),
            make_fact(
                "rev-9m",
                "Revenues",
                "350",
                "2025-01-01",
                "2025-09-30",
                accession="acc-q3",
                public_at="2025-11-01T12:00:00Z",
            ),
            make_fact(
                "rev-fy",
                "Revenues",
                "510",
                "2025-01-01",
                "2025-12-31",
                form="10-K",
                period_kind="annual",
                accession="acc-10k",
                filed="2026-02-23",
                public_at="2026-02-20T23:15:00Z",
            ),
        ]
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A, ASSET_A],
                "signal_session": ["2026-02-19", "2026-02-20"],
                "decision_at": ["2026-02-23T10:59:59Z", "2026-02-23T11:00:00Z"],
            }
        )
        res = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
            views=("revenue_q",),
            provenance=True,
        )
        self.assertEqual(res["revenue_q_value"].tolist(), [130.0, 160.0])
        self.assertEqual(
            res["revenue_q_period_end"].tolist(),
            [date(2025, 9, 30), date(2025, 12, 31)],
        )
        self.assertEqual(
            res["revenue_q_basis"].tolist(),
            ["ytd_difference", "fy_minus_ytd"],
        )

    def test_direct_quarter_preferred_over_difference(self) -> None:
        rows = [
            make_fact(
                "rev-q1",
                "Revenues",
                "100",
                "2025-01-01",
                "2025-03-31",
                accession="acc-q1",
                public_at="2025-05-01T12:00:00Z",
            ),
            make_fact(
                "rev-h1",
                "Revenues",
                "225",
                "2025-01-01",
                "2025-06-30",
                accession="acc-q2",
                public_at="2025-08-01T12:00:00Z",
            ),
            make_fact(
                "rev-q2-direct",
                "Revenues",
                "124",
                "2025-04-01",
                "2025-06-30",
                accession="acc-q2",
                public_at="2025-08-01T12:00:00Z",
            ),
        ]
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A],
                "signal_session": ["2025-08-04"],
                "decision_at": ["2025-08-05T10:00:00Z"],
            }
        )
        res = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
            views=("revenue_total_q", "revenue_q"),
            provenance=True,
        )
        self.assertEqual(res.iloc[0]["revenue_total_q_value"], 124.0)
        self.assertEqual(res.iloc[0]["revenue_total_q_basis"], "reported")
        self.assertEqual(res.iloc[0]["revenue_q_value"], 124.0)
        self.assertEqual(res.iloc[0]["revenue_q_basis"], "total")

    def test_parent_and_total_net_income_are_separate_not_ambiguous(self) -> None:
        rows = [
            make_fact(
                "ni-parent",
                "NetIncomeLoss",
                "90",
                "2025-01-01",
                "2025-03-31",
                accession="acc-1",
                public_at="2025-05-01T12:00:00Z",
            ),
            make_fact(
                "ni-total",
                "ProfitLoss",
                "100",
                "2025-01-01",
                "2025-03-31",
                accession="acc-1",
                public_at="2025-05-01T12:00:00Z",
            ),
        ]
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A],
                "signal_session": ["2025-05-02"],
                "decision_at": ["2025-05-05T10:00:00Z"],
            }
        )
        res = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
            views=("net_income_parent_q", "net_income_total_q", "net_income_q"),
            provenance=True,
        )
        row = res.iloc[0]
        self.assertEqual(row["net_income_parent_q_status"], "ok")
        self.assertEqual(row["net_income_parent_q_value"], 90.0)
        self.assertEqual(row["net_income_total_q_status"], "ok")
        self.assertEqual(row["net_income_total_q_value"], 100.0)
        self.assertEqual(row["net_income_q_status"], "ok")
        self.assertEqual(row["net_income_q_value"], 90.0)
        self.assertEqual(row["net_income_q_basis"], "parent")

    def test_revenues_beats_contract_revenue_for_headline(self) -> None:
        rows = [
            make_fact(
                "rev-headline",
                "Revenues",
                "150",
                "2025-01-01",
                "2025-03-31",
                accession="acc-1",
                public_at="2025-05-01T12:00:00Z",
            ),
            make_fact(
                "rev-contracts",
                "RevenueFromContractWithCustomerExcludingAssessedTax",
                "120",
                "2025-01-01",
                "2025-03-31",
                accession="acc-1",
                public_at="2025-05-01T12:00:00Z",
            ),
        ]
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A],
                "signal_session": ["2025-05-02"],
                "decision_at": ["2025-05-05T10:00:00Z"],
            }
        )
        res = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
            views=("revenue_q", "revenue_contracts_q"),
            provenance=True,
        )
        row = res.iloc[0]
        self.assertEqual(row["revenue_q_value"], 150.0)
        self.assertEqual(row["revenue_q_tag"], "Revenues")
        self.assertEqual(row["revenue_q_basis"], "total")
        self.assertEqual(row["revenue_contracts_q_value"], 120.0)

    def test_total_no_nci_fallback_only_without_nci(self) -> None:
        rows_no_nci = [
            make_fact(
                "ni-total",
                "ProfitLoss",
                "100",
                "2025-01-01",
                "2025-03-31",
                public_at="2025-05-01T12:00:00Z",
            ),
        ]
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A],
                "signal_session": ["2025-05-02"],
                "decision_at": ["2025-05-05T10:00:00Z"],
            }
        )
        without_nci = derived_fundamentals(
            make_material(rows_no_nci),
            samples,
            time_policy="public_reconstructed",
            views=("net_income_q",),
            provenance=True,
        )
        self.assertEqual(without_nci.iloc[0]["net_income_q_value"], 100.0)
        self.assertEqual(without_nci.iloc[0]["net_income_q_basis"], "total_no_nci")

        rows_with_nci = [
            *rows_no_nci,
            make_fact(
                "ni-nci",
                "NetIncomeLossAttributableToNoncontrollingInterest",
                "5",
                "2025-01-01",
                "2025-03-31",
                public_at="2025-05-01T12:00:00Z",
            ),
        ]
        with_nci = derived_fundamentals(
            make_material(rows_with_nci),
            samples,
            time_policy="public_reconstructed",
            views=("net_income_q",),
            provenance=True,
        )
        self.assertTrue(np.isnan(with_nci.iloc[0]["net_income_q_value"]))
        self.assertEqual(with_nci.iloc[0]["net_income_q_status"], "metric_missing")

    def test_within_tag_conflict_same_clock_is_ambiguous(self) -> None:
        rows = [
            make_fact(
                "rev-a",
                "Revenues",
                "100",
                "2025-01-01",
                "2025-03-31",
                accession="acc-a",
                public_at="",
                public_date="2025-05-01",
                public_time_precision="date",
                observed_at="2025-05-02T05:00:00Z",
            ),
            make_fact(
                "rev-b",
                "Revenues",
                "105",
                "2025-01-01",
                "2025-03-31",
                accession="acc-b",
                public_at="",
                public_date="2025-05-01",
                public_time_precision="date",
                observed_at="2025-05-02T05:00:00Z",
            ),
        ]
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A],
                "signal_session": ["2025-05-05"],
                "decision_at": ["2025-05-06T10:00:00Z"],
            }
        )
        res = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
            views=("revenue_q",),
        )
        self.assertEqual(res.iloc[0]["revenue_q_status"], "ambiguous")
        self.assertTrue(np.isnan(res.iloc[0]["revenue_q_value"]))

    def test_eps_q4_is_approximate_and_shares_never_subtracted(self) -> None:
        rows = [
            make_fact(
                "eps-9m",
                "EarningsPerShareDiluted",
                "3.10",
                "2025-01-01",
                "2025-09-30",
                unit="USD/shares",
                accession="acc-q3",
                public_at="2025-11-01T12:00:00Z",
            ),
            make_fact(
                "eps-fy",
                "EarningsPerShareDiluted",
                "4.50",
                "2025-01-01",
                "2025-12-31",
                unit="USD/shares",
                form="10-K",
                period_kind="annual",
                accession="acc-10k",
                public_at="2026-02-15T12:00:00Z",
            ),
            make_fact(
                "sh-9m",
                "WeightedAverageNumberOfSharesOutstandingBasic",
                "1000",
                "2025-01-01",
                "2025-09-30",
                unit="shares",
                currency="",
                accession="acc-q3",
                public_at="2025-11-01T12:00:00Z",
            ),
            make_fact(
                "sh-fy",
                "WeightedAverageNumberOfSharesOutstandingBasic",
                "1020",
                "2025-01-01",
                "2025-12-31",
                unit="shares",
                currency="",
                form="10-K",
                period_kind="annual",
                accession="acc-10k",
                public_at="2026-02-15T12:00:00Z",
            ),
        ]
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A],
                "signal_session": ["2026-02-18"],
                "decision_at": ["2026-02-19T11:00:00Z"],
            }
        )
        res = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
            views=(
                "eps_diluted_q",
                "shares_weighted_basic_q",
                "shares_weighted_basic_fy",
            ),
            provenance=True,
        )
        row = res.iloc[0]
        self.assertAlmostEqual(row["eps_diluted_q_value"], 1.40)
        self.assertEqual(row["eps_diluted_q_status"], "approximate")
        self.assertEqual(row["eps_diluted_q_basis"], "fy_minus_ytd_approx")
        self.assertEqual(row["shares_weighted_basic_q_status"], "period_unavailable")
        self.assertTrue(np.isnan(row["shares_weighted_basic_q_value"]))
        self.assertEqual(row["shares_weighted_basic_fy_value"], 1020.0)

    def test_retraction_under_observed_content_reverts_to_previous_filing(self) -> None:
        rows = [
            make_fact(
                "rev-1",
                "Revenues",
                "100",
                "2025-01-01",
                "2025-03-31",
                accession="acc-1",
                public_at="2025-05-01T12:00:00Z",
                observed_at="2025-05-01T12:00:00Z",
            ),
            make_fact(
                "rev-2",
                "Revenues",
                "120",
                "2025-01-01",
                "2025-03-31",
                accession="acc-2",
                public_at="2025-05-02T12:00:00Z",
                observed_at="2025-05-05T14:00:00Z",
                observation_sequence=1,
            ),
            make_fact(
                "rev-2",
                "Revenues",
                "120",
                "2025-01-01",
                "2025-03-31",
                accession="acc-2",
                public_at="",
                public_time_precision="unknown",
                observed_at="2025-05-06T14:00:00Z",
                observation_sequence=2,
                is_retracted=True,
            ),
        ]
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A, ASSET_A, ASSET_A],
                "signal_session": ["2025-05-02", "2025-05-05", "2025-05-06"],
                # Entry decisions at 10:00Z on 05-05, 05-06, 05-07; capture at 14:00Z - 3h = 11:00Z.
                "decision_at": [
                    "2025-05-05T10:00:00Z",
                    "2025-05-06T10:00:00Z",
                    "2025-05-07T10:00:00Z",
                ],
            }
        )
        obs = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="observed_content",
            views=("revenue_q",),
        )
        self.assertEqual(obs["revenue_q_value"].tolist(), [100.0, 120.0, 100.0])

        pub = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
            views=("revenue_q",),
        )
        self.assertEqual(pub["revenue_q_value"].tolist(), [120.0, 120.0, 120.0])


class FamilySchemaCompatibilityTest(unittest.TestCase):
    def test_wave2_family_schemas_and_manifest_v3_reader_compatibility(self) -> None:
        extra = {
            "corporate_actions": [
                {
                    "action_uid": "act-1",
                    "asset_id": bundle.ASSET_A,
                    "role": "subject",
                    "type": "forward_split",
                    "effect_date": "2026-01-12",
                    "split_ratio": 2.0,
                }
            ],
            "return_reconciliation": [
                {
                    "asset_id": bundle.ASSET_A,
                    "date": "2026-01-12",
                    "status": "agree",
                }
            ],
            "earnings_announcements": [
                {
                    "announcement_uid": "ann-1",
                    "asset_id": bundle.ASSET_A,
                    "public_at": "2026-01-15T21:05:00Z",
                    "period_end_estimated": "2025-12-31",
                }
            ],
            "issuer_profiles": [
                {
                    "cik": bundle.CIK_A,
                    "sic": "3571",
                    "fiscal_year_end": "0930",
                    "filer_category": "Large accelerated filer",
                    "observed_at": "2026-01-10T12:00:00Z",
                    "observation_sequence": 1,
                }
            ],
            "share_classes": [
                {
                    "cik": bundle.CIK_A,
                    "accession": "0001-26-000001",
                    "as_of_date": "2025-12-31",
                    "trading_symbol": "AAPL",
                    "value": "15000000000",
                    "public_at": "2026-01-05T20:10:00Z",
                    "observed_at": "2026-01-05T20:10:00Z",
                    "observation_sequence": 1,
                }
            ],
            "share_class_checks": [
                {
                    "cik": bundle.CIK_A,
                    "accession": "0001-26-000001",
                    "checked_at": "2026-01-06T00:00:00Z",
                    "status": "ok",
                }
            ],
        }
        objects, _ = bundle._build_synthetic_bundle(
            manifest_updates={
                "schema_version": 3,
                "calendar_closes": {"2026-01-12": "13:00"},
                "calendar_closes_complete": True,
                "sec_event_kinds": {"results_operations": {"items": ["2.02"]}},
            },
            family_updates={"event_observations": {"schema_version": 2}},
            extra_families=extra,
        )
        with (
            bundle.SyntheticDatasetServer(objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = research_datasets.load(
                bundle.DATASET_ID,
                key=bundle.TOKEN,
                base_url=server.base_url,
                cache_dir=tmp,
                preload=True,
            )
            self.assertEqual(ds.manifest["schema_version"], 3)
            self.assertEqual(len(ds.corporate_actions("AAPL")), 1)
            self.assertEqual(len(ds.return_reconciliation("AAPL")), 1)
            self.assertEqual(len(ds.family("earnings_announcements", "AAPL")), 1)
            self.assertEqual(len(ds.issuer_profiles("AAPL")), 1)
            self.assertEqual(len(ds.share_classes("AAPL")), 1)
            self.assertEqual(len(ds.share_class_checks("AAPL")), 1)
            self.assertFalse(ds.event_observations("AAPL").empty)

            tagged = ds.fundamentals("AAPL", tags="revenue")
            self.assertFalse(tagged.empty)
            self.assertEqual(set(tagged["tag"]), {"revenue"})

            streamed = list(ds.iter_fundamentals(ciks=[bundle.CIK_A]))
            self.assertEqual(
                sum(len(df) for df in streamed), len(ds.fundamentals("AAPL"))
            )

            self.assertEqual(
                cik_at(ds, [bundle.ASSET_A], ["2026-01-12"]).tolist(),
                [bundle.CIK_A],
            )
            self.assertEqual(asset_at(ds, "AAPL", "2026-01-12"), bundle.ASSET_A)

            states = fundamental_states(
                ds, time_policy="public_reconstructed", ciks=[bundle.CIK_A]
            )
            self.assertFalse(states.empty)


class TrailingAndFiscalQuartersTest(unittest.TestCase):
    def test_ttm_equals_fy_at_year_end(self) -> None:
        rows = [
            make_fact(
                "rev-q1",
                "Revenues",
                "100",
                "2025-01-01",
                "2025-03-31",
                accession="acc-q1",
                public_at="2025-05-01T12:00:00Z",
            ),
            make_fact(
                "rev-q2",
                "Revenues",
                "120",
                "2025-04-01",
                "2025-06-30",
                accession="acc-q2",
                public_at="2025-08-01T12:00:00Z",
            ),
            make_fact(
                "rev-q3",
                "Revenues",
                "140",
                "2025-07-01",
                "2025-09-30",
                accession="acc-q3",
                public_at="2025-11-01T12:00:00Z",
            ),
            make_fact(
                "rev-fy",
                "Revenues",
                "520",
                "2025-01-01",
                "2025-12-31",
                form="10-K",
                period_kind="annual",
                accession="acc-fy",
                public_at="2026-02-15T12:00:00Z",
            ),
            make_fact(
                "eps-q1",
                "EarningsPerShareDiluted",
                "1.00",
                "2025-01-01",
                "2025-03-31",
                unit="USD/shares",
                accession="acc-q1",
                public_at="2025-05-01T12:00:00Z",
            ),
            make_fact(
                "eps-fy",
                "EarningsPerShareDiluted",
                "4.85",
                "2025-01-01",
                "2025-12-31",
                unit="USD/shares",
                form="10-K",
                period_kind="annual",
                accession="acc-fy",
                public_at="2026-02-15T12:00:00Z",
            ),
        ]
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A],
                "signal_session": ["2026-02-18"],
                "decision_at": ["2026-02-19T11:00:00Z"],
            }
        )
        res = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
            views=("revenue_ttm", "revenue_fy", "eps_diluted_ttm", "eps_diluted_fy"),
            provenance=True,
        )
        row = res.iloc[0]
        self.assertAlmostEqual(row["revenue_ttm_value"], 520.0)
        self.assertAlmostEqual(row["revenue_fy_value"], 520.0)
        self.assertEqual(row["revenue_ttm_basis"], "fiscal_year")
        self.assertEqual(row["revenue_ttm_status"], "ok")
        self.assertAlmostEqual(row["eps_diluted_ttm_value"], 4.85)
        self.assertAlmostEqual(row["eps_diluted_fy_value"], 4.85)
        self.assertEqual(row["eps_diluted_ttm_basis"], "fiscal_year")
        self.assertEqual(row["eps_diluted_ttm_status"], "ok")

    def test_ttm_fy_bridge_and_quarter_sum(self) -> None:
        rows = [
            make_fact(
                "fy24",
                "Revenues",
                "400",
                "2024-01-01",
                "2024-12-31",
                form="10-K",
                period_kind="annual",
                accession="acc-24",
                public_at="2025-02-15T12:00:00Z",
            ),
            make_fact(
                "h1-24",
                "Revenues",
                "180",
                "2024-01-01",
                "2024-06-30",
                period_kind="ytd",
                accession="acc-25-q2",
                public_at="2025-08-01T12:00:00Z",
            ),
            make_fact(
                "h1-25",
                "Revenues",
                "230",
                "2025-01-01",
                "2025-06-30",
                period_kind="ytd",
                accession="acc-25-q2",
                public_at="2025-08-01T12:00:00Z",
            ),
            # EPS only has 4 non-overlapping quarters (no annual YTD bridge) -> quarter_sum + approximate
            make_fact(
                "eps-24q3",
                "EarningsPerShareDiluted",
                "1.10",
                "2024-07-01",
                "2024-09-30",
                unit="USD/shares",
                accession="acc-24q3",
                public_at="2024-11-01T12:00:00Z",
            ),
            make_fact(
                "eps-24q4",
                "EarningsPerShareDiluted",
                "1.20",
                "2024-10-01",
                "2024-12-31",
                unit="USD/shares",
                accession="acc-24q4",
                public_at="2025-02-15T12:00:00Z",
            ),
            make_fact(
                "eps-25q1",
                "EarningsPerShareDiluted",
                "1.30",
                "2025-01-01",
                "2025-03-31",
                unit="USD/shares",
                accession="acc-25q1",
                public_at="2025-05-01T12:00:00Z",
            ),
            make_fact(
                "eps-25q2",
                "EarningsPerShareDiluted",
                "1.40",
                "2025-04-01",
                "2025-06-30",
                unit="USD/shares",
                accession="acc-25q2",
                public_at="2025-08-01T12:00:00Z",
            ),
        ]
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A],
                "signal_session": ["2025-08-04"],
                "decision_at": ["2025-08-05T10:00:00Z"],
            }
        )
        res = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
            views=("revenue_ttm", "eps_diluted_ttm"),
            provenance=True,
        )
        row = res.iloc[0]
        # Bridge: 400 + 230 - 180 = 450
        self.assertAlmostEqual(row["revenue_ttm_value"], 450.0)
        self.assertEqual(row["revenue_ttm_basis"], "ytd_bridge")
        self.assertEqual(row["revenue_ttm_status"], "ok")
        # EPS quarter_sum: 1.10 + 1.20 + 1.30 + 1.40 = 5.00 -> status approximate
        self.assertAlmostEqual(row["eps_diluted_ttm_value"], 5.00)
        self.assertEqual(row["eps_diluted_ttm_basis"], "quarter_sum")
        self.assertEqual(row["eps_diluted_ttm_status"], "approximate")

    def test_twelve_month_column_in_10q_is_not_fiscal_year(self) -> None:
        # A 12-month column reported inside a 10-Q (minor 7) must never become `fy`
        # or legacy `annual`!
        rows = [
            make_fact(
                "fy24",
                "Revenues",
                "400",
                "2024-01-01",
                "2024-12-31",
                metric="revenue",
                form="10-K",
                period_kind="annual",
                accession="acc-10k",
                public_at="2025-02-15T12:00:00Z",
            ),
            make_fact(
                "tm-10q",
                "Revenues",
                "445",
                "2024-07-01",
                "2025-06-30",
                metric="revenue",
                form="10-Q",
                period_kind="annual",
                accession="acc-10q",
                public_at="2025-08-01T12:00:00Z",
            ),
        ]
        mat = make_material(rows)
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A],
                "signal_session": ["2025-08-04"],
                "decision_at": ["2025-08-05T10:00:00Z"],
            }
        )
        res = derived_fundamentals(
            mat,
            samples,
            time_policy="public_reconstructed",
            views=("revenue_fy",),
            provenance=True,
        )
        self.assertAlmostEqual(res.iloc[0]["revenue_fy_value"], 400.0)
        self.assertEqual(res.iloc[0]["revenue_fy_period_end"], date(2024, 12, 31))

        legacy = prepare_fundamental_features(
            mat,
            samples,
            metrics={"revenue": "USD"},
            period_kind="annual",
            time_policy="public_reconstructed",
        )
        self.assertAlmostEqual(legacy.iloc[0]["revenue_value"], 400.0)
        self.assertEqual(legacy.iloc[0]["revenue_period_end"], "2024-12-31")

    def test_52_53_week_yoy_tolerance(self) -> None:
        # 52/53-week retail calendar: prior year ends 2024-09-28 (364d), current ends 2025-09-27 (364d),
        # and Q4 ends 2024-09-28 (91d) vs 2025-09-27 (91d). Also test a 53-week year (+6d shift).
        rows = [
            make_fact(
                "fy24",
                "Revenues",
                "1000",
                "2023-10-01",
                "2024-09-28",
                form="10-K",
                period_kind="annual",
                accession="acc-24",
                public_at="2024-11-15T12:00:00Z",
            ),
            make_fact(
                "fy25",
                "Revenues",
                "1150",
                "2024-09-29",
                "2025-10-04",
                form="10-K",
                period_kind="annual",
                accession="acc-25",
                public_at="2025-11-15T12:00:00Z",
            ),
            make_fact(
                "q1-25",
                "Revenues",
                "250",
                "2024-09-29",
                "2024-12-28",
                accession="acc-q1-25",
                public_at="2025-02-01T12:00:00Z",
            ),
            make_fact(
                "q1-26",
                "Revenues",
                "300",
                "2025-10-05",
                "2026-01-03",
                accession="acc-q1-26",
                public_at="2026-02-05T12:00:00Z",
            ),
            make_fact(
                "assets-24",
                "Assets",
                "2000",
                None,
                "2024-12-28",
                period_kind="instant",
                accession="acc-q1-25",
                public_at="2025-02-01T12:00:00Z",
            ),
            make_fact(
                "assets-25",
                "Assets",
                "2200",
                None,
                "2026-01-03",
                period_kind="instant",
                accession="acc-q1-26",
                public_at="2026-02-05T12:00:00Z",
            ),
        ]
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A],
                "signal_session": ["2026-02-10"],
                "decision_at": ["2026-02-11T11:00:00Z"],
            }
        )
        res = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
            views=("revenue_fy_yoy", "revenue_q_yoy", "total_assets_i_yoy"),
        )
        row = res.iloc[0]
        self.assertEqual(row["revenue_fy_yoy_status"], "ok")
        self.assertAlmostEqual(row["revenue_fy_yoy_value"], 0.15)
        self.assertEqual(row["revenue_q_yoy_status"], "ok")
        self.assertAlmostEqual(row["revenue_q_yoy_value"], 0.20)
        self.assertEqual(row["total_assets_i_yoy_status"], "ok")
        self.assertAlmostEqual(row["total_assets_i_yoy_value"], 0.10)

    def test_leap_year_february_quarter_yoy(self) -> None:
        rows = [
            make_fact(
                "q-leap",
                "Revenues",
                "200",
                "2023-12-01",
                "2024-02-29",
                accession="acc-24",
                public_at="2024-04-05T12:00:00Z",
            ),
            make_fact(
                "q-nonleap",
                "Revenues",
                "240",
                "2024-12-01",
                "2025-02-28",
                accession="acc-25",
                public_at="2025-04-05T12:00:00Z",
            ),
        ]
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A],
                "signal_session": ["2025-04-10"],
                "decision_at": ["2025-04-11T10:00:00Z"],
            }
        )
        res = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
            views=("revenue_q_yoy",),
        )
        self.assertEqual(res.iloc[0]["revenue_q_yoy_status"], "ok")
        self.assertAlmostEqual(res.iloc[0]["revenue_q_yoy_value"], 0.20)

    def test_restated_comparative_changes_value_at_its_own_clock(self) -> None:
        rows = [
            make_fact(
                "q1-orig",
                "Revenues",
                "100",
                "2024-01-01",
                "2024-03-31",
                accession="acc-24q1",
                public_at="2024-05-01T12:00:00Z",
            ),
            # Restated comparative for 2024-Q1 reported inside 2025-Q1 10-Q
            make_fact(
                "q1-restated",
                "Revenues",
                "95",
                "2024-01-01",
                "2024-03-31",
                accession="acc-25q1",
                public_at="2025-05-01T12:00:00Z",
            ),
        ]
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A, ASSET_A],
                "signal_session": ["2024-05-06", "2025-05-06"],
                "decision_at": ["2024-05-07T10:00:00Z", "2025-05-07T10:00:00Z"],
            }
        )
        res = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
            views=("revenue_q",),
        )
        self.assertEqual(res["revenue_q_value"].tolist(), [100.0, 95.0])

    def test_age_days_and_stale_thresholds_by_view(self) -> None:
        rows = [
            make_fact(
                "rev-q1",
                "Revenues",
                "100",
                "2025-01-01",
                "2025-03-31",
                accession="acc-q1",
                public_at="2025-05-01T12:00:00Z",
            ),
            make_fact(
                "rev-fy",
                "Revenues",
                "400",
                "2024-01-01",
                "2024-12-31",
                form="10-K",
                period_kind="annual",
                accession="acc-fy",
                public_at="2025-02-15T12:00:00Z",
            ),
        ]
        # 2025-10-20 is 203 days after 2025-03-31 (> 200d for q) and 293 days after 2024-12-31 (< 460d for fy)
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A],
                "signal_session": ["2025-10-20"],
                "decision_at": ["2025-10-21T10:00:00Z"],
            }
        )
        res = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
            views=("revenue_q", "revenue_fy"),
        )
        row = res.iloc[0]
        self.assertEqual(row["revenue_q_age_days"], 203.0)
        self.assertEqual(row["revenue_q_status"], "stale")
        self.assertAlmostEqual(row["revenue_q_value"], 100.0)
        self.assertEqual(row["revenue_fy_age_days"], 293.0)
        self.assertEqual(row["revenue_fy_status"], "ok")

        # Custom stale_after_days override
        override = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
            views=("revenue_q",),
            stale_after_days={"q": 250},
        )
        self.assertEqual(override.iloc[0]["revenue_q_status"], "ok")

    def test_status_reasons(self) -> None:
        cik_unmapped = "unmapped-asset"
        cik_nonfiler = "0000000002"
        cik_annual_only = "0000000003"
        cik_v1_checked = "0000000004"

        rows = [
            # Annual-only foreign private issuer (20-F, no 10-Q/6-K)
            make_fact(
                "20f-rev",
                "Revenues",
                "800",
                "2024-01-01",
                "2024-12-31",
                cik=cik_annual_only,
                form="20-F",
                period_kind="annual",
                accession="acc-20f",
                public_at="2025-04-01T12:00:00Z",
            ),
            # v1-checked issuer has revenue only after 2025-05-01
            make_fact(
                "v1-rev",
                "Revenues",
                "100",
                "2025-01-01",
                "2025-03-31",
                cik=cik_v1_checked,
                accession="acc-v1",
                public_at="2025-05-01T12:00:00Z",
            ),
        ]
        mat = {
            "manifest": {"source_timezones": {"sec": "America/New_York"}},
            "universe": pd.DataFrame(
                [
                    {
                        "asset_id": cik_unmapped,
                        "cik": "",
                        "issuer_mapping_status": "unmapped",
                    },
                    {
                        "asset_id": "asset-nonfiler",
                        "cik": cik_nonfiler,
                        "issuer_mapping_status": "verified",
                    },
                    {
                        "asset_id": "asset-20f",
                        "cik": cik_annual_only,
                        "issuer_mapping_status": "verified",
                    },
                    {
                        "asset_id": "asset-v1",
                        "cik": cik_v1_checked,
                        "issuer_mapping_status": "verified",
                    },
                    {
                        "asset_id": "asset-unchecked",
                        "cik": "0000000005",
                        "issuer_mapping_status": "verified",
                    },
                ]
            ),
            "fundamentals": pd.DataFrame(rows),
            "financial_checks": pd.DataFrame(
                [
                    {
                        "cik": cik_nonfiler,
                        "check_sequence": 1,
                        "checked_at": "2025-01-01T00:00:00Z",
                        "status": "unsupported_filer",
                        "error_code": "SEC_NOT_PERIODIC_FILER",
                        "parser_version": "companyfacts-v2",
                    },
                    {
                        "cik": cik_annual_only,
                        "check_sequence": 1,
                        "checked_at": "2025-04-02T00:00:00Z",
                        "status": "checked",
                        "parser_version": "companyfacts-v2",
                    },
                    {
                        "cik": cik_v1_checked,
                        "check_sequence": 1,
                        "checked_at": "2025-05-02T00:00:00Z",
                        "status": "checked",
                        "parser_version": "companyfacts-v1",
                    },
                ]
            ),
        }
        samples = pd.DataFrame(
            [
                {
                    "asset_id": cik_unmapped,
                    "signal_session": "2025-06-02",
                    "decision_at": "2025-06-03T10:00:00Z",
                },
                {
                    "asset_id": "asset-nonfiler",
                    "signal_session": "2025-06-02",
                    "decision_at": "2025-06-03T10:00:00Z",
                },
                {
                    "asset_id": "asset-20f",
                    "signal_session": "2025-12-01",
                    "decision_at": "2025-12-02T11:00:00Z",
                },
                {
                    "asset_id": "asset-v1",
                    "signal_session": "2025-04-15",
                    "decision_at": "2025-04-16T10:00:00Z",
                },
                {
                    "asset_id": "asset-v1",
                    "signal_session": "2025-06-02",
                    "decision_at": "2025-06-03T10:00:00Z",
                },
                {
                    "asset_id": "asset-unchecked",
                    "signal_session": "2025-06-02",
                    "decision_at": "2025-06-03T10:00:00Z",
                },
            ]
        )
        res = derived_fundamentals(
            mat,
            samples,
            time_policy="public_reconstructed",
            views=("revenue_q", "revenue_ttm", "rnd_q", "gross_profit_q"),
        )
        self.assertEqual(res.iloc[0]["revenue_q_status"], "mapping_missing")
        self.assertEqual(res.iloc[1]["revenue_q_status"], "issuer_not_sec_filer")
        # 20-F issuer has annual_only for q, and ttm uses 460-day threshold (335d -> ok)
        self.assertEqual(res.iloc[2]["revenue_q_status"], "annual_only")
        self.assertEqual(res.iloc[2]["revenue_ttm_status"], "ok")
        self.assertAlmostEqual(res.iloc[2]["revenue_ttm_value"], 800.0)
        # Before first filing -> not_yet_available
        self.assertEqual(res.iloc[3]["revenue_q_status"], "not_yet_available")
        # v1 parser check -> min_parser=2 concept (rnd) is not_captured, min_parser=1 (gross_profit) is metric_missing
        self.assertEqual(res.iloc[4]["rnd_q_status"], "not_captured")
        self.assertEqual(res.iloc[4]["gross_profit_q_status"], "metric_missing")
        # Unchecked CIK -> not_checked
        self.assertEqual(res.iloc[5]["revenue_q_status"], "not_checked")

    def test_fiscal_quarters_first_and_latest_values(self) -> None:
        rows = [
            # Prior-year comparative reported in same filing as 2025-Q1
            make_fact(
                "eps-24q1-comp",
                "EarningsPerShareDiluted",
                "1.00",
                "2024-01-01",
                "2024-03-31",
                unit="USD/shares",
                accession="acc-25q1",
                public_at="2025-05-01T12:00:00Z",
            ),
            make_fact(
                "eps-25q1-first",
                "EarningsPerShareDiluted",
                "1.25",
                "2025-01-01",
                "2025-03-31",
                unit="USD/shares",
                accession="acc-25q1",
                public_at="2025-05-01T12:00:00Z",
            ),
            # Later restatement of 2025-Q1 in 2026-Q1 filing
            make_fact(
                "eps-25q1-restated",
                "EarningsPerShareDiluted",
                "1.22",
                "2025-01-01",
                "2025-03-31",
                unit="USD/shares",
                accession="acc-26q1",
                public_at="2026-05-01T12:00:00Z",
            ),
        ]
        fq = fiscal_quarters(
            make_material(rows),
            time_policy="public_reconstructed",
            concepts=("eps_diluted",),
        )
        q1_25 = fq[fq["period_end"] == date(2025, 3, 31)].iloc[0]
        self.assertAlmostEqual(q1_25["value_first"], 1.25)
        self.assertAlmostEqual(q1_25["value_latest"], 1.22)
        self.assertAlmostEqual(q1_25["prior_year_value_first"], 1.00)
        self.assertEqual(q1_25["prior_year_period_end_first"], date(2024, 3, 31))
        self.assertEqual(q1_25["accession_first"], "acc-25q1")
        self.assertEqual(q1_25["fiscal_quarter"], 1)
        self.assertEqual(
            q1_25["available_at_first"], pd.Timestamp("2025-05-01T12:00:00Z")
        )
        self.assertEqual(
            q1_25["available_at_latest"], pd.Timestamp("2026-05-01T12:00:00Z")
        )

    def test_fundamental_factors_alignment_and_zero_denominators(self) -> None:
        rows = [
            make_fact(
                "rev-fy",
                "Revenues",
                "0",
                "2025-01-01",
                "2025-12-31",
                form="10-K",
                period_kind="annual",
                accession="acc-fy",
                public_at="2026-02-15T12:00:00Z",
            ),
            make_fact(
                "gp-fy",
                "GrossProfit",
                "50",
                "2025-01-01",
                "2025-12-31",
                form="10-K",
                period_kind="annual",
                accession="acc-fy",
                public_at="2026-02-15T12:00:00Z",
            ),
            make_fact(
                "ni-fy",
                "NetIncomeLoss",
                "20",
                "2025-01-01",
                "2025-12-31",
                form="10-K",
                period_kind="annual",
                accession="acc-fy",
                public_at="2026-02-15T12:00:00Z",
            ),
            make_fact(
                "eq-i",
                "StockholdersEquity",
                "-100",
                None,
                "2025-12-31",
                form="10-K",
                period_kind="instant",
                accession="acc-fy",
                public_at="2026-02-15T12:00:00Z",
            ),
            make_fact(
                "assets-i",
                "Assets",
                "500",
                None,
                "2025-12-31",
                form="10-K",
                period_kind="instant",
                accession="acc-fy",
                public_at="2026-02-15T12:00:00Z",
            ),
        ]
        samples = pd.DataFrame(
            {
                "asset_id": [ASSET_A],
                "signal_session": ["2026-02-18"],
                "decision_at": ["2026-02-19T11:00:00Z"],
            }
        )
        derived = derived_fundamentals(
            make_material(rows),
            samples,
            time_policy="public_reconstructed",
        )
        factors = fundamental_factors(derived)
        row = factors.iloc[0]
        # Zero revenue -> invalid_value
        self.assertEqual(row["gross_margin_ttm_status"], "invalid_value")
        self.assertTrue(np.isnan(row["gross_margin_ttm_value"]))
        # Negative equity -> invalid_value on ROE
        self.assertEqual(row["roe_ttm_status"], "invalid_value")
        self.assertTrue(np.isnan(row["roe_ttm_value"]))
        # Positive total_assets (aligned at 2025-12-31) -> gross_profitability = 50 / 500 = 0.10, ROA = 20 / 500 = 0.04
        self.assertEqual(row["gross_profitability_status"], "ok")
        self.assertAlmostEqual(row["gross_profitability_value"], 0.10)
        self.assertEqual(row["roa_ttm_status"], "ok")
        self.assertAlmostEqual(row["roa_ttm_value"], 0.04)

    def test_state_cache_key_includes_policy_and_derivation_version(self) -> None:
        rows = [
            make_fact(
                "rev-q1",
                "Revenues",
                "100",
                "2025-01-01",
                "2025-03-31",
                accession="acc-q1",
                public_at="2025-05-01T12:00:00Z",
                observed_at="2025-05-10T12:00:00Z",
            ),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            mat = make_material(
                rows,
                cache_dir=tmp,
                manifest_sha256="a" * 64,
            )
            mat["manifest"]["dataset_id"] = "ds-cache-test"
            s_pub = fundamental_states(
                mat, time_policy="public_reconstructed", views=("revenue_q",)
            )
            s_obs = fundamental_states(
                mat, time_policy="observed_content", views=("revenue_q",)
            )
            # Cached reload hits disk and preserves exact timestamps & values
            s_pub_cached = fundamental_states(
                mat, time_policy="public_reconstructed", views=("revenue_q",)
            )
            self.assertNotEqual(
                s_pub.iloc[0]["available_at"], s_obs.iloc[0]["available_at"]
            )
            self.assertEqual(
                s_pub.iloc[0]["available_at"], s_pub_cached.iloc[0]["available_at"]
            )
            self.assertEqual(s_pub.iloc[0]["value"], s_pub_cached.iloc[0]["value"])


if __name__ == "__main__":
    unittest.main()
