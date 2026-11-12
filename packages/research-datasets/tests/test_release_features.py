"""Synthetic unit tests for release document and structured extraction features."""

from __future__ import annotations

import json
import unittest
from datetime import date

import numpy as np
import pandas as pd

import research_datasets
from research_datasets import (
    FAMILY_SPECS,
    RELEASE_COLUMNS,
    RELEASE_EXTRACTION_STATUSES,
    DatasetError,
    check_manifest,
    default_extractor_version,
    release_features,
)

ASSET_A = "11111111-1111-4111-8111-111111111111"
CIK_A = "0000100001"
EXTRACTOR_V2 = "rx2-synth00000000001"
EXTRACTOR_OTHER = "rx2-other99999999999"


def _decision_utc(entry_day: date) -> pd.Timestamp:
    return (
        pd.Timestamp(f"{entry_day.isoformat()} 06:00:00")
        .tz_localize("America/New_York")
        .tz_convert("UTC")
    )


def _business_sessions(start: str, count: int) -> list[date]:
    return [ts.date() for ts in pd.bdate_range(start=start, periods=count)]


def _candidates(sessions: list[date], indices: list[int]) -> pd.DataFrame:
    rows = []
    for idx in indices:
        rows.append(
            {
                "asset_id": ASSET_A,
                "signal_session": sessions[idx],
                "entry_session": sessions[idx + 1],
                "decision_at": _decision_utc(sessions[idx + 1]),
            }
        )
    return pd.DataFrame(rows)


class _SyntheticVersion:
    def __init__(
        self,
        *,
        calendar: list[date],
        default_extractor: str | None = None,
        release_documents: pd.DataFrame | None = None,
        extraction_results: pd.DataFrame | None = None,
        extraction_facts: pd.DataFrame | None = None,
        fundamentals_df: pd.DataFrame | None = None,
        daily_returns_df: pd.DataFrame | None = None,
        raw_prices_df: pd.DataFrame | None = None,
    ) -> None:
        data_families: dict[str, dict[str, int]] = {}
        self._frames: dict[str, pd.DataFrame] = {}
        for name, frame in (
            ("release_documents", release_documents),
            ("extraction_results", extraction_results),
            ("extraction_facts", extraction_facts),
            ("fundamentals", fundamentals_df),
            ("daily_returns", daily_returns_df),
        ):
            if frame is not None:
                data_families[name] = {"schema_version": 1}
                self._frames[name] = frame
        self.calendar = calendar
        self.universe = [
            {
                "asset_id": ASSET_A,
                "symbol": "EXMP",
                "cik": CIK_A,
                "issuer_mapping_status": "verified",
                "security_type": "common",
                "is_benchmark": False,
            }
        ]
        self.manifest = {
            "schema_version": 3,
            "client_min_version": "2.3.0",
            "calendar": [d.isoformat() for d in calendar],
            "universe": self.universe,
            "data_families": data_families,
            "extraction": {
                "default_extractor_version": default_extractor,
                "extractor_versions": [],
                "validator_versions": ["rv2.0"],
            },
        }
        self._raw_prices = raw_prices_df

    def family(self, name: str, symbols: object = None) -> pd.DataFrame:
        del symbols
        return self._frames[name].copy()

    def fundamentals(self, symbols: object = None) -> pd.DataFrame:
        del symbols
        return self._frames.get("fundamentals", pd.DataFrame()).copy()

    def total_returns(self, symbols: object = None) -> pd.DataFrame:
        del symbols
        return self._frames.get("daily_returns", pd.DataFrame()).copy()

    def prices(self, symbols: object = None, *, adjusted: bool = False) -> pd.DataFrame:
        del symbols, adjusted
        if self._raw_prices is None:
            return pd.DataFrame()
        return self._raw_prices.copy()


class ReleaseFeaturesTest(unittest.TestCase):
    def test_family_specs_and_manifest_validation(self) -> None:
        self.assertEqual(research_datasets.__version__, "2.3.0")
        self.assertEqual(
            FAMILY_SPECS["release_documents"].identity,
            "cik",
        )
        self.assertEqual(
            FAMILY_SPECS["release_documents"].part_clock,
            "accepted_at",
        )
        self.assertEqual(
            FAMILY_SPECS["extraction_results"].part_clock,
            "recorded_at",
        )
        self.assertEqual(
            FAMILY_SPECS["extraction_facts"].part_clock,
            "accepted_at",
        )
        check_manifest(
            {
                "schema_version": 3,
                "client_min_version": "2.3.0",
                "extraction": {
                    "default_extractor_version": None,
                    "extractor_versions": [{"version": EXTRACTOR_V2}],
                },
            }
        )
        with self.assertRaises(DatasetError):
            check_manifest(
                {
                    "schema_version": 3,
                    "extraction": {"default_extractor_version": 123},
                }
            )

    def test_absent_extractor_or_families_emits_no_columns(self) -> None:
        sessions = _business_sessions("2025-01-02", 10)
        cands = _candidates(sessions, [0, 1])
        docs = pd.DataFrame(
            [
                {
                    "document_id": f"sec_release_documents:{CIK_A}:0001-25-000001:ex991.htm",
                    "cik": CIK_A,
                    "accession": "0001-25-000001",
                    "accepted_at": "2025-01-02T21:15:00Z",
                    "filing_date": "2025-01-02",
                    "sequence": 2,
                    "role": "press_release",
                    "capture_status": "captured",
                    "observed_at": "2025-01-02T21:20:00Z",
                }
            ]
        )
        ver_no_default = _SyntheticVersion(
            calendar=sessions,
            default_extractor=None,
            release_documents=docs,
        )
        self.assertIsNone(default_extractor_version(ver_no_default))
        empty = release_features(
            ver_no_default, cands, time_policy="public_reconstructed"
        )
        self.assertTrue(empty.columns.empty)
        self.assertEqual(len(empty), 2)

        ver_no_docs = _SyntheticVersion(
            calendar=sessions,
            default_extractor=EXTRACTOR_V2,
            release_documents=None,
        )
        empty_no_docs = release_features(
            ver_no_docs, cands, time_policy="public_reconstructed"
        )
        self.assertTrue(empty_no_docs.columns.empty)
        self.assertIn("release_documents", empty_no_docs.attrs["release_missing"])

    def test_valid_facts_clocks_sequence_and_features(self) -> None:
        sessions = _business_sessions("2025-01-02", 140)
        # Release 1 accepted after close on session[0] (2025-01-02 16:30 ET = 21:30Z),
        # so public_at = 2025-01-03 06:00 ET = entry_session of candidate idx 0!
        # Recorded_at is 3 days later (2025-01-06 15:00Z), testing observed_content gate!
        doc_supp = f"sec_release_documents:{CIK_A}:0001-25-000010:ex990.htm"
        doc_pr1 = f"sec_release_documents:{CIK_A}:0001-25-000010:ex991.htm"
        doc_pr2 = f"sec_release_documents:{CIK_A}:0001-25-000010:ex992.htm"
        doc_r2 = f"sec_release_documents:{CIK_A}:0001-25-000020:ex991.htm"
        docs = pd.DataFrame(
            [
                {
                    "document_id": doc_supp,
                    "cik": CIK_A,
                    "accession": "0001-25-000010",
                    "accepted_at": "2025-01-02T21:30:00Z",
                    "filing_date": "2025-01-02",
                    "sequence": 1,
                    "role": "supplemental",
                    "capture_status": "captured",
                    "observed_at": "2025-01-02T22:00:00Z",
                },
                {
                    "document_id": doc_pr1,
                    "cik": CIK_A,
                    "accession": "0001-25-000010",
                    "accepted_at": "2025-01-02T21:30:00Z",
                    "filing_date": "2025-01-02",
                    "sequence": 2,
                    "role": "press_release",
                    "capture_status": "captured",
                    "observed_at": "2025-01-02T22:00:00Z",
                },
                {
                    "document_id": doc_pr2,
                    "cik": CIK_A,
                    "accession": "0001-25-000010",
                    "accepted_at": "2025-01-02T21:30:00Z",
                    "filing_date": "2025-01-02",
                    "sequence": 3,
                    "role": "letter",
                    "capture_status": "captured",
                    "observed_at": "2025-01-02T22:00:00Z",
                },
                {
                    "document_id": doc_r2,
                    "cik": CIK_A,
                    "accession": "0001-25-000020",
                    "accepted_at": f"{sessions[5].isoformat()}T21:30:00Z",
                    "filing_date": sessions[5].isoformat(),
                    "sequence": 2,
                    "role": "press_release",
                    "capture_status": "captured",
                    "observed_at": f"{sessions[5].isoformat()}T22:00:00Z",
                },
            ]
        )
        results = pd.DataFrame(
            [
                {
                    "document_id": doc_r2,
                    "cik": CIK_A,
                    "accession": "0001-25-000020",
                    "extractor_version": EXTRACTOR_V2,
                    "run_index": 1,
                    "status": "done",
                    "recorded_at": f"{sessions[5].isoformat()}T22:05:00Z",
                }
            ]
        )
        facts = pd.DataFrame(
            [
                # Valid headline revenue on primary press release (doc_pr1)
                {
                    "document_id": doc_pr1,
                    "cik": CIK_A,
                    "accession": "0001-25-000010",
                    "extractor_version": EXTRACTOR_V2,
                    "run_index": 1,
                    "fact_index": 0,
                    "fact_type": "result",
                    "metric": "revenue",
                    "basis": "gaap",
                    "share_basis": "",
                    "period_kind": "quarter",
                    "fiscal_year": 2024,
                    "quarter": 4,
                    "period_relation": "reported",
                    "action": "",
                    "unit": "money",
                    "value_low_base": 1_200_000_000.0,
                    "value_high_base": 1_200_000_000.0,
                    "validation_status": "valid",
                    "accepted_at": "2025-01-02T21:30:00Z",
                    "recorded_at": f"{sessions[3].isoformat()}T15:00:00Z",
                    "evidence_json": json.dumps([{"offset": 100}]),
                },
                # Rejected net_income must NEVER leak into features!
                {
                    "document_id": doc_pr1,
                    "cik": CIK_A,
                    "accession": "0001-25-000010",
                    "extractor_version": EXTRACTOR_V2,
                    "run_index": 1,
                    "fact_index": 1,
                    "fact_type": "result",
                    "metric": "net_income",
                    "basis": "gaap",
                    "share_basis": "",
                    "period_kind": "quarter",
                    "fiscal_year": 2024,
                    "quarter": 4,
                    "period_relation": "reported",
                    "action": "",
                    "unit": "money",
                    "value_low_base": 999_000_000.0,
                    "value_high_base": 999_000_000.0,
                    "validation_status": "rejected",
                    "accepted_at": "2025-01-02T21:30:00Z",
                    "recorded_at": f"{sessions[3].isoformat()}T15:00:00Z",
                    "evidence_json": json.dumps([{"offset": 120}]),
                },
                # Other extractor version must NEVER leak!
                {
                    "document_id": doc_pr1,
                    "cik": CIK_A,
                    "accession": "0001-25-000010",
                    "extractor_version": EXTRACTOR_OTHER,
                    "run_index": 1,
                    "fact_index": 2,
                    "fact_type": "result",
                    "metric": "net_income",
                    "basis": "gaap",
                    "share_basis": "",
                    "period_kind": "quarter",
                    "fiscal_year": 2024,
                    "quarter": 4,
                    "period_relation": "reported",
                    "action": "",
                    "unit": "money",
                    "value_low_base": 888_000_000.0,
                    "value_high_base": 888_000_000.0,
                    "validation_status": "valid",
                    "accepted_at": "2025-01-02T21:30:00Z",
                    "recorded_at": f"{sessions[3].isoformat()}T15:00:00Z",
                    "evidence_json": json.dumps([{"offset": 130}]),
                },
                # Fact on sequence 3 letter (doc_pr2) ignored because sequence 2 press_release wins!
                {
                    "document_id": doc_pr2,
                    "cik": CIK_A,
                    "accession": "0001-25-000010",
                    "extractor_version": EXTRACTOR_V2,
                    "run_index": 1,
                    "fact_index": 0,
                    "fact_type": "result",
                    "metric": "net_income",
                    "basis": "gaap",
                    "share_basis": "",
                    "period_kind": "quarter",
                    "fiscal_year": 2024,
                    "quarter": 4,
                    "period_relation": "reported",
                    "action": "",
                    "unit": "money",
                    "value_low_base": 777_000_000.0,
                    "value_high_base": 777_000_000.0,
                    "validation_status": "valid",
                    "accepted_at": "2025-01-02T21:30:00Z",
                    "recorded_at": f"{sessions[3].isoformat()}T15:00:00Z",
                    "evidence_json": json.dumps([{"offset": 50}]),
                },
                # Raised FY revenue guidance with inline previous midpoint + buyback + dividend
                {
                    "document_id": doc_pr1,
                    "cik": CIK_A,
                    "accession": "0001-25-000010",
                    "extractor_version": EXTRACTOR_V2,
                    "run_index": 1,
                    "fact_index": 3,
                    "fact_type": "guidance",
                    "metric": "revenue",
                    "basis": "gaap",
                    "share_basis": "",
                    "period_kind": "full_year",
                    "fiscal_year": 2025,
                    "quarter": np.nan,
                    "period_relation": "current_fiscal_year",
                    "action": "raised",
                    "unit": "money",
                    "value_low_base": 5_400_000_000.0,
                    "value_high_base": 5_600_000_000.0,
                    "validation_status": "valid",
                    "accepted_at": "2025-01-02T21:30:00Z",
                    "recorded_at": f"{sessions[3].isoformat()}T15:00:00Z",
                    "evidence_json": json.dumps(
                        {
                            "previous_low_base": 4_900_000_000.0,
                            "previous_high_base": 5_100_000_000.0,
                        }
                    ),
                },
                {
                    "document_id": doc_pr1,
                    "cik": CIK_A,
                    "accession": "0001-25-000010",
                    "extractor_version": EXTRACTOR_V2,
                    "run_index": 1,
                    "fact_index": 4,
                    "fact_type": "buyback",
                    "metric": "",
                    "basis": "unspecified",
                    "share_basis": "",
                    "period_kind": "other",
                    "fiscal_year": np.nan,
                    "quarter": np.nan,
                    "period_relation": "other",
                    "action": "authorized",
                    "unit": "money",
                    "value_low_base": 500_000_000.0,
                    "value_high_base": 500_000_000.0,
                    "validation_status": "valid",
                    "accepted_at": "2025-01-02T21:30:00Z",
                    "recorded_at": f"{sessions[3].isoformat()}T15:00:00Z",
                    "evidence_json": "[]",
                },
                {
                    "document_id": doc_pr1,
                    "cik": CIK_A,
                    "accession": "0001-25-000010",
                    "extractor_version": EXTRACTOR_V2,
                    "run_index": 1,
                    "fact_index": 5,
                    "fact_type": "dividend",
                    "metric": "",
                    "basis": "unspecified",
                    "share_basis": "",
                    "period_kind": "quarter",
                    "fiscal_year": np.nan,
                    "quarter": np.nan,
                    "period_relation": "other",
                    "action": "raised",
                    "unit": "money_per_share",
                    "value_low_base": 0.55,
                    "value_high_base": 0.55,
                    "validation_status": "valid",
                    "accepted_at": "2025-01-02T21:30:00Z",
                    "recorded_at": f"{sessions[3].isoformat()}T15:00:00Z",
                    "evidence_json": json.dumps({"previous_mid_base": 0.50}),
                },
            ]
        )

        version = _SyntheticVersion(
            calendar=sessions,
            default_extractor=EXTRACTOR_V2,
            release_documents=docs,
            extraction_results=results,
            extraction_facts=facts,
        )
        cands = _candidates(sessions, [0, 3, 5, 130])
        fund = pd.DataFrame(
            {"market_cap_issuer_value": [10_000_000_000.0] * 4}, index=cands.index
        )

        # Under public_reconstructed, release 1 facts are immediately visible at idx 0!
        pub_out = release_features(
            version,
            cands,
            time_policy="public_reconstructed",
            fundamentals=fund,
        )
        self.assertEqual(tuple(pub_out.columns), RELEASE_COLUMNS)
        self.assertEqual(
            tuple(pub_out["release_extraction_status"].cat.categories),
            RELEASE_EXTRACTION_STATUSES,
        )
        self.assertEqual(pub_out.loc[0, "release_extraction_status"], "valid_facts")
        self.assertEqual(pub_out.loc[0, "release_sessions_since"], 0.0)
        self.assertEqual(pub_out.loc[0, "release_revenue"], 1_200_000_000.0)
        self.assertTrue(np.isnan(pub_out.loc[0, "release_net_income"]))
        self.assertEqual(pub_out.loc[0, "guidance_revenue_raised"], 1.0)
        self.assertEqual(pub_out.loc[0, "guidance_revenue_lowered"], 0.0)
        self.assertAlmostEqual(pub_out.loc[0, "guidance_revenue_fy_mid_change"], 0.10)
        self.assertAlmostEqual(pub_out.loc[0, "buyback_authorized_365d_to_mcap"], 0.05)
        self.assertAlmostEqual(pub_out.loc[0, "dividend_change_pct"], 0.10)

        # At idx 5 (entry session[6]), release 2 is done with 0 facts -> status "no_facts",
        # while latest guidance within 120 sessions still reflects release 1!
        self.assertEqual(pub_out.loc[2, "release_extraction_status"], "no_facts")
        self.assertEqual(pub_out.loc[2, "guidance_revenue_raised"], 1.0)

        # At idx 130 (> 120 sessions after release 2), status ages out to "document_missing"!
        self.assertEqual(
            pub_out.loc[3, "release_extraction_status"], "document_missing"
        )
        self.assertTrue(np.isnan(pub_out.loc[3, "release_sessions_since"]))

        # Under observed_content, at idx 0 (before recorded_at on sessions[3]), facts are NOT yet visible!
        obs_out = release_features(
            version,
            cands,
            time_policy="observed_content",
            fundamentals=fund,
        )
        self.assertEqual(obs_out.loc[0, "release_extraction_status"], "not_extracted")
        self.assertTrue(np.isnan(obs_out.loc[0, "release_revenue"]))
        # At idx 3 (entry session[4] 06:00 ET > sessions[3] 15:00Z recorded_at), facts become visible!
        self.assertEqual(obs_out.loc[1, "release_extraction_status"], "valid_facts")
        self.assertEqual(obs_out.loc[1, "release_revenue"], 1_200_000_000.0)


if __name__ == "__main__":
    unittest.main()
