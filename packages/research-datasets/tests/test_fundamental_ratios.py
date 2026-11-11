"""Derived financial ratios keep explicit accounting and as-of bases (moved private cases)."""

from __future__ import annotations

import random
import unittest
from copy import deepcopy
from datetime import timedelta

import pandas as pd
from pandas.testing import assert_frame_equal

from research_datasets import (
    clocks,
    fundamentals,
    prepare_fundamental_features,
    prepare_fundamental_ratios,
)
from tests import reference
from tests.test_fundamental_features import SESSIONS, random_material

CLASS_A = "00000000-0000-4000-8000-000000000001"
CLASS_B = "00000000-0000-4000-8000-000000000002"
VALUES = {
    "revenue": "200.00",
    "gross_profit": "80",
    "operating_income": "40",
    "net_income": "20",
    "operating_cash_flow": "50",
    "capex": "15",
}


def fact(metric, value, **changes):
    return {
        "fact_id": f"{metric}-current",
        "cik": "0000000001",
        "metric": metric,
        "source": "sec",
        "taxonomy": "us-gaap",
        "tag": metric,
        "tag_priority": 1,
        "unit": "USD",
        "currency": "USD",
        "value": value,
        "period_start": "2025-10-01",
        "period_end": "2025-12-31",
        "period_kind": "quarter",
        "form": "10-Q",
        "accession": "0000000001-26-000001",
        "public_at": "2026-03-06T12:00:00Z",
        "public_date": "2026-03-06",
        "public_time_precision": "second",
        "observed_at": "2026-03-06T12:00:00Z",
        "observation_sequence": 1,
        "is_retracted": False,
        **changes,
    }


def material():
    rows = [fact(metric, value) for metric, value in VALUES.items()]
    rows.append(
        fact(
            "revenue",
            "100",
            fact_id="revenue-prior",
            accession="0000000001-25-000001",
            period_start="2024-10-01",
            period_end="2024-12-31",
            public_at="2025-03-06T12:00:00Z",
            observed_at="2025-03-06T12:00:00Z",
        )
    )
    return {
        "manifest": {"source_timezones": {"sec": "America/New_York"}},
        "universe": pd.DataFrame(
            [
                {
                    "asset_id": asset,
                    "cik": "0000000001",
                    "issuer_mapping_status": "verified",
                }
                for asset in (CLASS_A, CLASS_B)
            ]
        ),
        "fundamentals": pd.DataFrame(rows),
    }


def samples():
    # 06:00 New York on the entry session (daylight time from 2026-03-08).
    return pd.DataFrame(
        [
            {"asset_id": asset, "signal_session": day, "decision_at": decision}
            for asset in (CLASS_A, CLASS_B)
            for day, decision in (
                ("2026-03-06", "2026-03-09T10:00:00Z"),
                ("2026-03-09", "2026-03-10T10:00:00Z"),
                ("2026-03-10", "2026-03-11T10:00:00Z"),
            )
        ]
    )


def ratios(source, candidates, **changes):
    return prepare_fundamental_ratios(
        source,
        candidates,
        time_policy=changes.pop("time_policy", "observed_content"),
        **changes,
    )


def filing_material(seed: int) -> tuple[dict, pd.DataFrame]:
    """Whole filings (every ratio input under one accession and period) with
    prior-year filings, plus perturbed bases, zeros and overflowing values."""
    rng = random.Random(seed)
    source, candidates = random_material(seed)
    decisions = [clocks.decision_at(day) for day in SESSIONS]
    rows, sequence = [], 0
    for issuer in ("0000000001", "0000000002"):
        for year in (2024, 2025):
            for start, end in (("10-01", "12-31"), ("07-01", "09-30")):
                sequence += 1
                public = rng.choice(decisions) - timedelta(days=400 * (2025 - year))
                observed = public + timedelta(minutes=rng.randrange(0, 600))
                filing = f"{issuer[-1]}-{year}-{end}"
                for metric in fundamentals.RATIO_INPUTS:
                    if metric != "revenue" and year == 2024:
                        continue
                    row = {
                        "fact_id": f"{filing}-{metric}",
                        "cik": issuer,
                        "metric": metric,
                        "source": "sec",
                        "tag": metric,
                        "unit": "USD",
                        "currency": "USD",
                        "value": rng.choice(
                            ["200", "80", "40", "0", "-15", "1e308", "1e-308", "100"]
                        ),
                        "period_start": f"{year}-{start}",
                        "period_end": f"{year}-{end}",
                        "period_kind": rng.choice(["quarter", "quarter", "annual"]),
                        "accession": filing,
                        "public_time_precision": rng.choice(
                            ["second"] * 5 + ["unknown"]
                        ),
                        "public_at": public.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "public_date": public.date().isoformat(),
                        "observed_at": observed.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "observation_sequence": sequence,
                        "is_retracted": False,
                    }
                    roll = rng.random()
                    if roll < 0.04:
                        row["accession"] = filing + "-other"
                    elif roll < 0.08:
                        row["period_start"] = f"{year}-11-01"
                    elif roll < 0.12:
                        row["cik"] = issuer.lstrip("0")  # same issuer, other spelling
                    elif roll < 0.15:
                        row["currency"] = ""
                    elif roll < 0.18:
                        row["currency"] = "EUR"
                    rows.append(row)
    source["fundamentals"] = pd.concat(
        [source["fundamentals"], pd.DataFrame(rows)], ignore_index=True
    )
    return source, candidates


class DerivedFundamentalsTest(unittest.TestCase):
    def test_money_formulas_and_source_decimal_refs(self):
        result = ratios(material(), samples())
        for name, expected in {
            "gross_margin": 0.4,
            "operating_margin": 0.2,
            "net_margin": 0.1,
            "free_cash_flow": 35,
            "free_cash_flow_margin": 0.175,
            "revenue_yoy": 1,
        }.items():
            self.assertAlmostEqual(result.iloc[0][f"{name}_value"], expected)
            self.assertEqual(set(result[f"{name}_status"]), {"ok"})
        self.assertEqual(set(result.source_revenue_raw_value), {"200.00"})
        self.assertEqual(
            set(result.source_operating_cash_flow_fact_id),
            {"operating_cash_flow-current"},
        )
        self.assertEqual(set(result.prior_revenue_fact_id), {"revenue-prior"})
        self.assertFalse(
            any(
                isinstance(value, (pd.DataFrame, pd.Series))
                for value in result.attrs.values()
            )
        )

    def test_period_and_accession_mismatches_block_mixed_bases(self):
        source = material()
        facts = source["fundamentals"]
        facts.loc[facts.metric == "operating_income", "accession"] = (
            "0000000001-26-000002"
        )
        facts.loc[facts.metric == "net_income", ["period_start", "period_end"]] = [
            "2025-07-01",
            "2025-09-30",
        ]
        result = ratios(source, samples())
        self.assertEqual(set(result.operating_margin_status), {"accession_mismatch"})
        self.assertEqual(set(result.net_margin_status), {"period_mismatch"})
        self.assertTrue(result.operating_margin_value.isna().all())
        self.assertEqual(result.iloc[0].gross_margin_value, 0.4)

    def test_zero_revenue_does_not_zero_fill_margins_and_cash_flow_keeps_sign(self):
        source = material()
        source["fundamentals"].loc[
            source["fundamentals"].fact_id == "revenue-current", "value"
        ] = "0"
        result = ratios(source, samples())
        for metric in (
            "gross_margin",
            "operating_margin",
            "net_margin",
            "free_cash_flow_margin",
        ):
            self.assertEqual(set(result[f"{metric}_status"]), {"zero_revenue"})
            self.assertTrue(result[f"{metric}_value"].isna().all())
        self.assertEqual(result.iloc[0].free_cash_flow_value, 35)
        self.assertEqual(result.iloc[0].revenue_yoy_value, -1)
        source = material()
        source["fundamentals"].loc[
            source["fundamentals"].metric == "operating_cash_flow", "value"
        ] = "-50"
        source["fundamentals"].loc[
            source["fundamentals"].metric == "capex", "value"
        ] = "-15"
        result = ratios(source, samples())
        self.assertEqual(result.iloc[0].free_cash_flow_value, -35)
        self.assertAlmostEqual(result.iloc[0].free_cash_flow_margin_value, -0.175)

    def test_missing_metrics_and_wrong_units_are_explicit(self):
        source = material()
        source["fundamentals"] = source["fundamentals"][
            source["fundamentals"].metric != "capex"
        ]
        result = ratios(source, samples())
        self.assertEqual(set(result.free_cash_flow_status), {"input_unavailable"})
        self.assertEqual(set(result.source_capex_status), {"metric_missing"})
        result = ratios(material(), samples(), currency="EUR")
        self.assertEqual(set(result.gross_margin_status), {"input_unavailable"})
        self.assertEqual(set(result.source_revenue_status), {"unit_unavailable"})
        self.assertTrue(result.gross_margin_value.isna().all())

    def test_yoy_comparative_value_uses_current_decision_not_prior_year_clock(self):
        source = material()
        facts = source["fundamentals"]
        facts.loc[
            facts.fact_id == "revenue-prior", ["value", "public_at", "observed_at"]
        ] = ["80", "2026-03-05T12:00:00Z", "2026-03-05T12:00:00Z"]
        later = facts[facts.fact_id == "revenue-prior"].iloc[0].to_dict()
        # Captured 14:00Z, usable from 11:00Z: after the 10:00Z decision of 03-10.
        later.update(
            value="100", observation_sequence=2, observed_at="2026-03-10T14:00:00Z"
        )
        source["fundamentals"] = pd.concat(
            [facts, pd.DataFrame([later])], ignore_index=True
        )
        result = ratios(source, samples())
        self.assertEqual(result.revenue_yoy_value.iloc[:3].tolist(), [1.5, 1.5, 1.0])
        self.assertEqual(
            result.prior_revenue_raw_value.iloc[:3].tolist(), ["80", "80", "100"]
        )
        self.assertEqual(set(result.prior_revenue_period_end), {"2024-12-31"})
        # The comparative is the latest report of the prior period at the same decision.
        assert_frame_equal(
            result[["asset_id", "signal_session"]],
            samples()[["asset_id", "signal_session"]],
        )

    def test_non_calendar_year_period_and_zero_prior_revenue_stay_missing(self):
        source = material()
        prior = source["fundamentals"].fact_id == "revenue-prior"
        source["fundamentals"].loc[prior, ["period_start", "period_end"]] = [
            "2024-09-29",
            "2024-12-29",
        ]
        result = ratios(source, samples())
        self.assertEqual(set(result.revenue_yoy_status), {"unverified_prior_period"})
        self.assertTrue(result.revenue_yoy_value.isna().all())
        source = material()
        source["fundamentals"].loc[
            source["fundamentals"].fact_id == "revenue-prior", "value"
        ] = "0"
        self.assertEqual(
            set(ratios(source, samples()).revenue_yoy_status),
            {"zero_prior_revenue"},
        )

    def test_report_period_upper_limit_is_independent_and_leap_day_is_clamped(self):
        source = material()
        candidates = samples()
        candidates["report_period_end"] = "2024-12-31"
        panel = prepare_fundamental_features(
            source,
            candidates,
            metrics={"revenue": "USD"},
            time_policy="observed_content",
        )
        self.assertEqual(set(panel.revenue_raw_value), {"100"})
        source["fundamentals"].loc[
            source["fundamentals"].fact_id == "revenue-current",
            ["period_start", "period_end"],
        ] = ["2024-02-29", "2024-05-28"]
        source["fundamentals"].loc[
            source["fundamentals"].fact_id == "revenue-prior",
            ["period_start", "period_end"],
        ] = ["2023-02-28", "2023-05-28"]
        result = ratios(source, samples())
        self.assertEqual(set(result.revenue_yoy_status), {"ok"})

    def test_multiple_share_classes_and_duplicate_sample_order_are_unchanged(self):
        candidates = samples().iloc[[5, 0, 5, 3]]
        original = deepcopy(candidates)
        result = ratios(material(), candidates)
        assert_frame_equal(
            result[["asset_id", "signal_session"]],
            candidates[["asset_id", "signal_session"]],
        )
        assert_frame_equal(candidates, original)
        self.assertEqual(len(result), 4)
        self.assertTrue(result.columns.is_unique)
        self.assertEqual(len(ratios(material(), candidates.iloc[:0])), 0)

    def test_provenance_false_keeps_ratio_values_and_categorical_status(self):
        full = ratios(material(), samples())
        lean = ratios(material(), samples(), provenance=False)
        self.assertFalse(
            [name for name in lean if name.startswith(("source_", "prior_"))]
        )
        for name in ("gross_margin", "revenue_yoy"):
            self.assertIsInstance(lean[f"{name}_status"].dtype, pd.CategoricalDtype)
            assert_frame_equal(
                lean[[f"{name}_value", f"{name}_status"]].astype(
                    {f"{name}_status": object}
                ),
                full[[f"{name}_value", f"{name}_status"]],
            )

    def test_ratios_port_matches_reference(self):
        statuses: dict[str, int] = {}
        for seed in range(40):
            source, candidates = (
                random_material(seed) if seed % 2 else filing_material(seed)
            )
            for policy in ("public_reconstructed", "observed_content"):
                for kind in ("quarter", "annual"):
                    for currency in ("USD", "EUR"):
                        with self.subTest(
                            seed=seed, policy=policy, kind=kind, currency=currency
                        ):
                            expected = reference.reference_fundamental_ratios(
                                source,
                                candidates,
                                currency=currency,
                                period_kind=kind,
                                time_policy=policy,
                            )
                            actual = prepare_fundamental_ratios(
                                source,
                                candidates,
                                currency=currency,
                                period_kind=kind,
                                time_policy=policy,
                            )
                            assert_frame_equal(actual, expected)
                            self.assertEqual(actual.attrs, expected.attrs)
                            for name in fundamentals.RATIO_STATUSES:
                                for column in actual.filter(regex="_status$"):
                                    if column.startswith(("source_", "prior_")):
                                        continue
                                    hits = int((actual[column] == name).sum())
                                    statuses[name] = statuses.get(name, 0) + hits
        missing = {name for name, count in statuses.items() if count == 0}
        self.assertEqual(missing, set(), statuses)


if __name__ == "__main__":
    unittest.main()
