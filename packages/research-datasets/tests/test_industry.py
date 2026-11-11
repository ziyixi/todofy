"""Tests for SIC, division, Fama-French 12 mappings, non-PIT flags, and neutralization."""

from __future__ import annotations

import tempfile
import unittest
from datetime import date

import pandas as pd

import research_datasets
from research_datasets import (
    FF12_CODES,
    INDUSTRY_COLUMNS,
    SIC_LIMITATION,
    industry,
    normalize_sic,
    sic_to_division,
    sic_to_ff12,
    sic_to_major_group,
)
from tests import test_sdk as bundle

ASSET_1 = "00000000-0000-4000-8000-000000000001"
ASSET_2 = "00000000-0000-4000-8000-000000000002"
CIK_1 = "0000000001"
CIK_2 = "0000000002"


class IndustryTest(unittest.TestCase):
    def test_sic_is_flagged_non_pit(self) -> None:
        """sic_pit is always False; public_reconstructed uses latest snapshot while observed_content hides future captures."""
        profiles = pd.DataFrame(
            [
                {
                    "cik": CIK_1,
                    "sic": "3571",
                    "fiscal_year_end": "0930",
                    "filer_category": "Large accelerated filer",
                    "observed_at": "2025-01-10T12:00:00Z",
                    "observation_sequence": 1,
                },
                {
                    "cik": CIK_1,
                    "sic": "7372",
                    "fiscal_year_end": "1231",
                    "filer_category": "Large accelerated filer",
                    "observed_at": "2025-08-01T12:00:00Z",
                    "observation_sequence": 2,
                },
            ]
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
                        "issuer_mapping_status": "unmapped",
                    },
                ]
            ),
            "issuer_profiles": profiles,
        }
        samples = pd.DataFrame(
            [
                {
                    "asset_id": ASSET_1,
                    "signal_session": date(2025, 3, 3),
                    "decision_at": pd.Timestamp("2025-03-04T11:00:00Z"),
                },
                {
                    "asset_id": ASSET_2,
                    "signal_session": date(2025, 3, 3),
                    "decision_at": pd.Timestamp("2025-03-04T11:00:00Z"),
                },
            ]
        )
        pub = industry(material, samples, time_policy="public_reconstructed")
        obs = industry(material, samples, time_policy="observed_content")

        for col in INDUSTRY_COLUMNS:
            self.assertIn(col, pub.columns)
            self.assertIn(col, obs.columns)

        # sic_pit is False on EVERY row (mapped and unmapped, both policies)
        self.assertEqual(pub["sic_pit"].tolist(), [False, False])
        self.assertEqual(obs["sic_pit"].tolist(), [False, False])
        self.assertTrue((pub["sic_basis"] == "current_backfilled").all())
        self.assertTrue((obs["sic_basis"] == "observed_before_decision").all())

        # public_reconstructed backfills the latest snapshot (7372); observed_content sees 3571 at 2025-03-04
        self.assertEqual(pub.loc[0, "sic"], "7372")
        self.assertEqual(pub.loc[0, "fiscal_year_end"], "1231")
        self.assertEqual(obs.loc[0, "sic"], "3571")
        self.assertEqual(obs.loc[0, "fiscal_year_end"], "0930")

        # Unmapped security gets empty strings
        self.assertEqual(pub.loc[1, "sic"], "")
        self.assertEqual(pub.loc[1, "ff12"], "")
        self.assertIn(SIC_LIMITATION, pub.attrs["limitations"])

    def test_sic_division_major_group_and_ff12_mappings(self) -> None:
        cases = [
            ("200", "0200", "02", "A", "NoDur"),
            ("3711", "3711", "37", "D", "Durbl"),
            ("3550", "3550", "35", "D", "Manuf"),
            ("1311", "1311", "13", "B", "Enrgy"),
            ("2810", "2810", "28", "D", "Chems"),
            ("7372", "7372", "73", "I", "BusEq"),
            ("4813", "4813", "48", "E", "Telcm"),
            ("4911", "4911", "49", "E", "Utils"),
            ("5411", "5411", "54", "G", "Shops"),
            ("2834", "2834", "28", "D", "Hlth"),
            ("6021", "6021", "60", "H", "Money"),
            ("1520", "1520", "15", "C", "Other"),
            ("", "", "", "", ""),
            (None, "", "", "", ""),
        ]
        seen_ff12 = set()
        for raw, exp_sic, exp_mg, exp_div, exp_ff12 in cases:
            self.assertEqual(normalize_sic(raw), exp_sic)
            self.assertEqual(sic_to_major_group(raw), exp_mg)
            self.assertEqual(sic_to_division(raw), exp_div)
            self.assertEqual(sic_to_ff12(raw), exp_ff12)
            if exp_ff12:
                seen_ff12.add(exp_ff12)
        self.assertEqual(seen_ff12, set(FF12_CODES))

    def test_panel_and_forward_returns_industry_and_size_neutralization(self) -> None:
        prof_rows = [
            {
                "cik": bundle.CIK_A,
                "sic": "3571",
                "fiscal_year_end": "0930",
                "filer_category": "Large accelerated filer",
                "observed_at": "2026-01-01T00:00:00Z",
                "observation_sequence": 1,
            },
            {
                "cik": bundle.CIK_G,
                "sic": "7370",
                "fiscal_year_end": "1231",
                "filer_category": "Large accelerated filer",
                "observed_at": "2026-01-01T00:00:00Z",
                "observation_sequence": 1,
            },
        ]
        objects, _ = bundle._build_synthetic_bundle(
            extra_families={"issuer_profiles": prof_rows}
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
            )
            pnl = ds.panel(
                ["AAPL", "GOOG", "GOOGL"],
                start=ds.calendar[6],
                end=ds.calendar[7],
                horizons=[1],
                neutralize=["ff12", "size"],
                time_policy="public_reconstructed",
                allow_static_universe=True,
            )
            self.assertIn("ff12", pnl.columns)
            self.assertIn("sic_pit", pnl.columns)
            self.assertTrue((~pnl["sic_pit"]).all())
            self.assertIn("market_cap_issuer_value", pnl.columns)
            self.assertIn("excess_return_1d_ff12", pnl.columns)
            self.assertIn("excess_return_1d_size", pnl.columns)
            self.assertIn(SIC_LIMITATION, pnl.attrs["provenance"]["limitations"])

            fr = ds.forward_returns(
                ["AAPL", "GOOG", "GOOGL"],
                start=ds.calendar[6],
                end=ds.calendar[7],
                horizons=[1],
                neutralize=["ff12"],
                allow_static_universe=True,
            )
            self.assertIn("excess_return_1d_ff12", fr.columns)
            self.assertIn(SIC_LIMITATION, fr.attrs["limitations"])


if __name__ == "__main__":
    unittest.main()
