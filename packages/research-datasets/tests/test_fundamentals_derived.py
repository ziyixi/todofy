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


if __name__ == "__main__":
    unittest.main()
