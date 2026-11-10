"""As-of fact joins: moved private recipe cases (06:00 decisions) and the port's oracle."""

from __future__ import annotations

import random
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

import pandas as pd
from pandas.testing import assert_frame_equal

from research_datasets import clocks, fundamentals, prepare_fundamental_features
from tests import reference

CLASS_A = "00000000-0000-4000-8000-000000000001"
CLASS_B = "00000000-0000-4000-8000-000000000002"
UNMAPPED = "00000000-0000-4000-8000-000000000003"
CIK = "0000000001"
# 06:00 New York on the entry session (daylight time from 2026-03-08).
DECISIONS = (
    ("2026-03-06", "2026-03-09T10:00:00Z"),
    ("2026-03-09", "2026-03-10T10:00:00Z"),
    ("2026-03-10", "2026-03-11T10:00:00Z"),
    ("2026-03-11", "2026-03-12T10:00:00Z"),
)


def fact(**changes):
    row = {
        "fact_id": "one",
        "cik": CIK,
        "metric": "revenue",
        "source": "sec",
        "taxonomy": "us-gaap",
        "tag": "Revenues",
        "tag_priority": 2,
        "unit": "USD",
        "currency": "USD",
        "value": "100",
        "period_start": "2025-10-01",
        "period_end": "2025-12-31",
        "period_kind": "quarter",
        "form": "10-Q",
        "accession": "0000000001-26-000001",
        "public_at": "2026-03-06T12:00:00Z",
        "public_date": "2026-03-06",
        "public_time_precision": "second",
        "observed_at": "2026-03-06T12:00:00Z",
        "content_first_seen_at": "2026-03-06T12:00:00Z",
        "observation_sequence": 1,
        "is_retracted": False,
        "source_url": "https://example.invalid/fact",
    }
    return {**row, **changes}


def material(rows=None):
    return {
        "manifest": {
            "source_timezones": {"sec": "America/New_York"},
            "limitations": ["Synthetic"],
        },
        "universe": pd.DataFrame(
            [
                {"asset_id": asset, "cik": CIK, "issuer_mapping_status": "verified"}
                for asset in (CLASS_A, CLASS_B)
            ]
            + [{"asset_id": UNMAPPED, "cik": "", "issuer_mapping_status": "unknown"}]
        ),
        "fundamentals": pd.DataFrame([fact()] if rows is None else rows),
    }


def samples(assets=(CLASS_A,)):
    return pd.DataFrame(
        [
            {"asset_id": asset, "signal_session": day, "decision_at": decision}
            for asset in assets
            for day, decision in DECISIONS
        ]
    )


class FundamentalFeaturesTest(unittest.TestCase):
    def prepare(self, source=None, candidates=None, **changes):
        return prepare_fundamental_features(
            material() if source is None else source,
            samples() if candidates is None else candidates,
            metrics=changes.pop("metrics", {"revenue": "USD"}),
            time_policy=changes.pop("time_policy", "observed_content"),
            **changes,
        )

    def test_later_capture_and_later_filing_do_not_change_earlier_samples(self):
        baseline = self.prepare()
        # Captured 14:00Z: usable from 11:00Z (capture grace), after the first decision.
        later = fact(
            observation_sequence=2, value="110", observed_at="2026-03-09T14:00:00Z"
        )
        source = material([fact(), later])
        result = self.prepare(source)
        assert_frame_equal(baseline.iloc[:1], result.iloc[:1])
        self.assertEqual(result.revenue_value.tolist(), [100, 110, 110, 110])
        source["fundamentals"] = pd.DataFrame(
            [
                fact(),
                fact(
                    fact_id="new-filing",
                    value="200",
                    accession="0000000001-26-000002",
                    public_at="2026-03-10T13:00:00Z",
                    observed_at="2026-03-10T13:00:00Z",
                ),
                fact(fact_id="future-period", value="999", period_end="2026-03-31"),
            ]
        )
        result = self.prepare(source)
        self.assertEqual(result.revenue_value.tolist(), [100, 100, 200, 200])
        self.assertEqual(result.iloc[2].revenue_fact_id, "new-filing")

    def test_observed_withdrawal_and_reappearance_use_actual_capture_clocks(self):
        source = material(
            [
                fact(),
                fact(
                    observation_sequence=2,
                    value="110",
                    observed_at="2026-03-09T14:00:00Z",
                ),
                fact(
                    observation_sequence=3,
                    is_retracted=True,
                    public_at="",
                    public_date="",
                    public_time_precision="unknown",
                    observed_at="2026-03-10T14:00:00Z",
                ),
                fact(observation_sequence=4, observed_at="2026-03-11T14:00:00Z"),
            ]
        )
        result = self.prepare(source)
        self.assertEqual(
            result.revenue_status.tolist(), ["ok", "ok", "retracted", "ok"]
        )
        self.assertEqual(result.revenue_value.iloc[:2].tolist(), [100, 110])
        self.assertTrue(pd.isna(result.revenue_value.iloc[2]))
        self.assertEqual(result.revenue_value.iloc[3], 100)
        public = self.prepare(source, time_policy="public_reconstructed")
        self.assertEqual(public.revenue_value.tolist(), [100, 100, 100, 100])

    def test_public_state_requires_advanced_verified_public_clock(self):
        source = material(
            [
                fact(),
                fact(
                    observation_sequence=2,
                    value="110",
                    observed_at="2026-03-10T14:00:00Z",
                ),
                fact(
                    observation_sequence=3,
                    value="200",
                    public_at="2026-03-10T13:00:00Z",
                    observed_at="2026-03-12T14:00:00Z",
                ),
            ]
        )
        result = self.prepare(source, time_policy="public_reconstructed")
        self.assertEqual(result.revenue_value.tolist(), [100, 100, 200, 200])
        self.assertIn("as-filed", result.attrs["limitations"][-1])

    def test_share_classes_keep_uuid_rows_and_missing_mappings_units_periods(self):
        candidates = samples((CLASS_A, CLASS_B, UNMAPPED))
        result = self.prepare(candidates=candidates)
        assert_frame_equal(
            result[["asset_id", "signal_session"]],
            candidates[["asset_id", "signal_session"]],
        )
        self.assertEqual(len(result), 12)
        self.assertEqual(result.revenue_value.iloc[:8].tolist(), [100] * 8)
        self.assertEqual(
            result.revenue_status.iloc[8:].tolist(), ["mapping_missing"] * 4
        )
        self.assertEqual(
            set(self.prepare(metrics={"revenue": "EUR"}).revenue_status),
            {"unit_unavailable"},
        )
        self.assertEqual(
            set(self.prepare(material([fact(period_kind="annual")])).revenue_status),
            {"period_unavailable"},
        )
        self.assertEqual(
            set(self.prepare(material([fact(period_end="")])).revenue_status),
            {"period_unavailable"},
        )
        self.assertEqual(
            set(self.prepare(metrics={"cash": "USD"}).cash_status), {"metric_missing"}
        )
        empty = self.prepare(candidates=candidates.iloc[:0])
        self.assertEqual(len(empty), 0)
        self.assertIn("revenue_status", empty)

    def test_unknown_public_is_observed_only_and_declared_bad_clocks_stay_unknown(self):
        source = material(
            [fact(public_at="", public_date="", public_time_precision="unknown")]
        )
        observed = self.prepare(source)
        self.assertEqual(set(observed.revenue_status), {"ok_observed_only"})
        self.assertTrue(observed.revenue_public_clock_missing.all())
        self.assertEqual(set(observed.revenue_availability_basis), {"observed_only"})
        self.assertEqual(
            set(
                self.prepare(source, time_policy="public_reconstructed").revenue_status
            ),
            {"clock_unknown"},
        )
        for changes in ({"public_at": "2026-03-06T12:00:00"}, {"observed_at": ""}):
            result = self.prepare(material([fact(**changes)]))
            self.assertEqual(set(result.revenue_status), {"clock_unknown"})
            self.assertTrue(result.revenue_value.isna().all())

    def test_unreadable_public_clock_blocks_from_capture_minus_grace(self):
        # Observed: a version whose declared public clock is unreadable is a possible
        # value (clock_unknown) once its capture minus CAPTURE_GRACE is at or before the
        # decision: 13:00Z is exactly the 10:00Z decision of 03-10 plus three hours.
        for observed, expected in (
            ("2026-03-10T13:00:00Z", ["not_yet_available"] + ["clock_unknown"] * 3),
            ("2026-03-10T13:01:00Z", ["not_yet_available"] * 2 + ["clock_unknown"] * 2),
        ):
            with self.subTest(observed=observed):
                source = material(
                    [fact(public_at="2026-03-09T12:00:00", observed_at=observed)]
                )
                self.assertEqual(self.prepare(source).revenue_status.tolist(), expected)
                self.assertEqual(
                    set(
                        self.prepare(
                            source, time_policy="public_reconstructed"
                        ).revenue_status
                    ),
                    {"clock_unknown"},
                )

    def test_multiple_metrics_preserve_candidate_order_and_do_not_multiply_rows(self):
        source = material(
            [fact(), fact(fact_id="income", metric="net_income", value="10")]
        )
        candidates = samples((CLASS_A, CLASS_B)).iloc[[3, 0, 3, 7, 4]]
        result = self.prepare(
            source, candidates, metrics={"revenue": "USD", "net_income": "USD"}
        )
        assert_frame_equal(
            result[["asset_id", "signal_session"]],
            candidates[["asset_id", "signal_session"]],
        )
        self.assertEqual(len(result), 5)
        self.assertTrue(result.columns.is_unique)
        self.assertEqual(result.revenue_value.tolist(), [100] * 5)
        self.assertEqual(result.net_income_value.tolist(), [10] * 5)
        self.assertEqual(
            result.attrs["parameters"]["metrics"],
            {"revenue": "USD", "net_income": "USD"},
        )

    def test_alias_conflicts_are_ambiguous_and_priority_only_breaks_equal_values(self):
        aliases = [
            fact(),
            fact(fact_id="alias", tag="SalesRevenueNet", tag_priority=1, value="101"),
        ]
        result = self.prepare(material(aliases))
        self.assertEqual(set(result.revenue_status), {"ambiguous"})
        self.assertTrue(result.revenue_value.isna().all())
        aliases[1]["value"] = "100.0"
        result = self.prepare(material(aliases))
        self.assertEqual(set(result.revenue_status), {"ok"})
        self.assertEqual(set(result.revenue_tag), {"SalesRevenueNet"})
        self.assertEqual(set(result.revenue_raw_value), {"100.0"})

    def test_decimal_provenance_and_nonfinite_model_values(self):
        exact = "1000000000000000000.1234567890123456789"
        result = self.prepare(material([fact(value=exact)]))
        self.assertEqual(set(result.revenue_raw_value), {exact})
        self.assertEqual(set(result.revenue_unit), {"USD"})
        self.assertEqual(set(result.revenue_accession), {"0000000001-26-000001"})
        result = self.prepare(material([fact(value="1e1000")]))
        self.assertEqual(set(result.revenue_status), {"nonfinite_model_value"})
        self.assertEqual(set(result.revenue_raw_value), {"1e1000"})
        self.assertTrue(result.revenue_value.isna().all())

    def test_fixed_version_adapter_and_real_parquet_roundtrip(self):
        source, calls = material(), []
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "facts.parquet"
            source["fundamentals"].to_parquet(path)
            source["fundamentals"] = pd.read_parquet(path)

            class Version:
                manifest = source["manifest"]
                universe = source["universe"]

                def fundamentals(self, symbols=None, metrics=None):
                    calls.append((symbols, metrics))
                    return source["fundamentals"]

            result = self.prepare(Version())
            output = Path(directory) / "features.parquet"
            result.to_parquet(output)
            assert_frame_equal(result, pd.read_parquet(output))
        self.assertEqual(calls, [([CLASS_A], ["revenue"])])

    def test_sec_fact_public_uses_filed_date_rule(self):
        # Accepted Friday 18:10 New York; SEC dates it Tuesday (Monday is a SEC holiday
        # but a trading session), so it is public at 06:00 on Tuesday, not on Monday.
        accepted = fact(
            public_at="2026-10-09T22:10:00Z",
            public_date="2026-10-09",
            observed_at="2026-10-09T22:11:00Z",
            filed="2026-10-13",
        )
        candidates = pd.DataFrame(
            {
                "asset_id": [CLASS_A] * 2,
                "signal_session": ["2026-10-09", "2026-10-12"],
                "decision_at": ["2026-10-12T10:00:00Z", "2026-10-13T10:00:00Z"],
            }
        )
        for policy in ("public_reconstructed", "observed_content"):
            with self.subTest(policy=policy):
                result = self.prepare(
                    material([accepted]), candidates, time_policy=policy
                )
                self.assertEqual(
                    result.revenue_status.tolist(), ["not_yet_available", "ok"]
                )
                self.assertEqual(
                    result.revenue_available_at.iloc[1],
                    pd.Timestamp("2026-10-13T10:00:00Z"),
                )
                # Without a filing date the acceptance instant is the public clock.
                undated = self.prepare(
                    material([{**accepted, "filed": ""}]),
                    candidates,
                    time_policy=policy,
                )
                self.assertEqual(undated.revenue_status.tolist(), ["ok", "ok"])

    def test_report_period_limit_below_an_unavailable_period_scans_lower(self):
        rows = [
            fact(),
            # A later quarter, stored but public only after the second decision.
            fact(
                fact_id="q1",
                value="300",
                period_start="2026-01-01",
                period_end="2026-03-31",
                public_at="2026-03-10T12:00:00Z",
                observed_at="2026-03-10T12:00:00Z",
            ),
            fact(
                fact_id="q1-restated",
                value="310",
                period_start="2026-01-01",
                period_end="2026-03-31",
                public_at="2026-03-11T12:00:00Z",
                observed_at="2026-03-11T12:00:00Z",
                accession="0000000001-26-000003",
            ),
        ]
        candidates = samples()
        candidates["signal_session"] = "2026-04-01"
        candidates["report_period_end"] = [
            "2026-03-31",
            "2026-03-31",
            None,
            "2026-01-15",
        ]
        for policy in ("public_reconstructed", "observed_content"):
            with self.subTest(policy=policy):
                result = self.prepare(material(rows), candidates, time_policy=policy)
                self.assertEqual(
                    result.revenue_status.tolist(),
                    ["ok", "ok", "period_unavailable", "ok"],
                )
                self.assertEqual(
                    result.revenue_raw_value.tolist(), ["100", "100", None, "100"]
                )
                self.assertEqual(result.revenue_period_end.iloc[0], "2025-12-31")

    def test_provenance_false_keeps_value_and_categorical_status(self):
        full = self.prepare(candidates=samples((CLASS_A, UNMAPPED)))
        lean = self.prepare(candidates=samples((CLASS_A, UNMAPPED)), provenance=False)
        self.assertEqual(
            list(lean.columns),
            ["asset_id", "signal_session", "revenue_value", "revenue_status"],
        )
        self.assertIsInstance(lean.revenue_status.dtype, pd.CategoricalDtype)
        assert_frame_equal(
            lean.astype({"revenue_status": object}),
            full[lean.columns],
        )


# --- randomized equivalence with the scalar oracle -----------------------------------

ISSUERS = ("0000000001", "0000000002", "0000000003")
UNIVERSE = (
    ("10000000-0000-4000-8000-000000000001", "1", "verified"),  # two share classes
    ("10000000-0000-4000-8000-000000000002", "0000000001", "verified"),
    ("10000000-0000-4000-8000-000000000003", "0000000002", "verified"),
    ("10000000-0000-4000-8000-000000000004", "0000000003", "unknown"),
    ("10000000-0000-4000-8000-000000000005", "0000000099", "verified"),  # no facts
    ("10000000-0000-4000-8000-000000000006", "abc", "verified"),
)
METRICS = ("revenue", "gross_profit", "operating_income", "capex", "cash")
PERIODS = (
    ("2024-10-01", "2024-12-31"),
    ("2025-01-01", "2025-03-31"),
    ("2025-07-01", "2025-09-30"),
    ("2025-10-01", "2025-12-31"),
    ("2026-01-01", "2026-03-31"),
)
VALUES = ("100", "100", "100.0", "120", "250", "-40", "0", "abc", "1e1000", "NaN", 7)


def _sessions() -> list[date]:
    day, days = date(2025, 12, 1), []
    while day <= date(2026, 4, 15):
        if day.weekday() < 5:
            days.append(day)
        day += timedelta(days=1)
    return days


SESSIONS = _sessions()


def random_material(seed: int) -> tuple[dict, pd.DataFrame]:
    """Fact chains with revisions, retractions, unknown and invalid clocks, SEC filing
    dates, aliases and periods around one year apart; samples with ties to clocks."""
    rng = random.Random(seed)
    decisions = [clocks.decision_at(day) for day in SESSIONS]

    def instant() -> pd.Timestamp:
        anchor = rng.choice(decisions)
        roll = rng.random()
        if roll < 0.3:
            return anchor
        if roll < 0.4:
            return anchor + timedelta(hours=3)
        return anchor + timedelta(minutes=rng.randrange(-2000, 2000))

    def text(value: pd.Timestamp) -> str:
        return value.strftime("%Y-%m-%dT%H:%M:%SZ")

    rows = []
    for issuer in ISSUERS:
        for metric in METRICS:
            for chain in range(rng.randrange(0, 5)):
                start, end = rng.choice(PERIODS)
                if rng.random() < 0.1:
                    start = "2025-11-01"
                base = {
                    "fact_id": f"{issuer[-1]}-{metric}-{chain}",
                    "cik": issuer,
                    "metric": metric,
                    "source": "sec",
                    "tag": rng.choice(["A", "B"]),
                    "tag_priority": rng.randrange(3),
                    "unit": rng.choice(["USD", "USD", "USD", "EUR"]),
                    "currency": "USD",
                    "period_start": start,
                    "period_end": rng.choice([end] * 8 + ["", None]),
                    "period_kind": rng.choice(
                        ["quarter", "quarter", "annual", "instant"]
                    ),
                    "accession": rng.choice(["acc-1", "acc-1", "acc-2"]),
                }
                public = instant()
                sequences = sorted(rng.sample(range(1, 40), rng.randrange(1, 5)))
                chain_rows = []
                for sequence in sequences:
                    if rng.random() < 0.4:
                        public = instant()
                    observed = public + timedelta(minutes=rng.randrange(-300, 3000))
                    row = {
                        **base,
                        "value": rng.choice(VALUES),
                        "observation_sequence": sequence,
                        "is_retracted": rng.random() < 0.12,
                        "public_time_precision": "second",
                        "public_at": text(public),
                        "public_date": public.date().isoformat(),
                        "observed_at": text(observed),
                    }
                    roll = rng.random()
                    if roll < 0.1:
                        row.update(public_time_precision="unknown", public_at="")
                    elif roll < 0.15:
                        row.update(public_time_precision="date", public_at="")
                    elif roll < 0.18:
                        row["public_at"] = text(public)[:-1]  # declared, unreadable
                    elif roll < 0.25:
                        row["filed"] = (
                            (public + timedelta(days=rng.randrange(0, 3)))
                            .date()
                            .isoformat()
                        )
                    if rng.random() < 0.05:
                        row["observed_at"] = ""
                    chain_rows.append(row)
                rows.extend(chain_rows)
                if rng.random() < 0.3:  # an alias tag reported with the same clocks
                    rows.extend(
                        {
                            **row,
                            "fact_id": row["fact_id"] + "-alias",
                            "tag": "C",
                            "tag_priority": rng.randrange(3),
                            "value": rng.choice([row["value"], "100.00", "101"]),
                        }
                        for row in chain_rows
                    )
    rng.shuffle(rows)
    facts = pd.DataFrame(rows)
    universe = pd.DataFrame(
        [
            {"asset_id": asset, "cik": cik, "issuer_mapping_status": status}
            for asset, cik, status in UNIVERSE
        ]
    )
    sample_rows = []
    for asset, *_ in UNIVERSE:
        for day in rng.sample(SESSIONS[:-1], 18):
            entry = SESSIONS[SESSIONS.index(day) + 1]
            decision = clocks.decision_at(entry)
            sample_rows.append(
                {
                    "asset_id": asset,
                    "signal_session": rng.choice([day, day.isoformat()]),
                    "decision_at": rng.choice(
                        [
                            text(decision),
                            text(decision),
                            decision,
                            "",
                            "2026-01-05T11:00:00",
                        ]
                        if rng.random() < 0.1
                        else [text(decision), decision]
                    ),
                    "report_period_end": rng.choice(
                        [
                            None,
                            "",
                            "2025-12-31",
                            "2025-06-30",
                            "2026-03-31",
                            date(2025, 10, 15),
                        ]
                    ),
                }
            )
    rng.shuffle(sample_rows)
    candidates = pd.DataFrame(sample_rows)
    if seed % 2:
        candidates = candidates.drop(columns="report_period_end")
    candidates.index = [rng.randrange(5) for _ in range(len(candidates))]
    manifest = {"source_timezones": {"sec": "America/New_York"}, "limitations": ["S"]}
    return {
        "manifest": manifest,
        "universe": universe,
        "fundamentals": facts,
    }, candidates


class FundamentalsPortTest(unittest.TestCase):
    def test_fundamentals_port_matches_reference(self):
        statuses: dict[str, int] = {}
        scans = []
        original = fundamentals.FactEngine._scan_lower

        def counted(engine, *args):
            scans.append(args)
            return original(engine, *args)

        metrics = {
            "revenue": "USD",
            "gross_profit": "USD",
            "capex": "EUR",
            "cash": "USD",
        }
        with mock.patch.object(
            fundamentals.FactEngine, "_scan_lower", autospec=True, side_effect=counted
        ):
            for seed in range(30):
                source, candidates = random_material(seed)
                for policy in ("public_reconstructed", "observed_content"):
                    for kind in ("quarter", "annual", "instant"):
                        with self.subTest(seed=seed, policy=policy, kind=kind):
                            expected = reference.reference_fundamental_features(
                                source,
                                candidates,
                                metrics=metrics,
                                period_kind=kind,
                                time_policy=policy,
                            )
                            actual = prepare_fundamental_features(
                                source,
                                candidates,
                                metrics=metrics,
                                period_kind=kind,
                                time_policy=policy,
                            )
                            assert_frame_equal(actual, expected)
                            self.assertEqual(actual.attrs, expected.attrs)
                            for metric in metrics:
                                for status in actual[f"{metric}_status"]:
                                    statuses[status] = statuses.get(status, 0) + 1
        # Not vacuous: every status occurs and the lower-period scan was exercised.
        self.assertEqual(set(statuses), set(fundamentals.STATUSES))
        self.assertGreater(len(scans), 0)
        self.assertGreater(statuses["ok"], 1000)


if __name__ == "__main__":
    unittest.main()
