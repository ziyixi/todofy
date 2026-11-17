"""Look-ahead guard for derived fundamentals and valuation: truncation invariance.

Random fact histories (restated comparatives, amendments, corrected and retracted
observations, YTD-only cash-flow tags, twelve-week interims, annual-only filers and a
late first filer) are read once in full and once without the facts that become
available after a cutoff. Every output row decided at or before the cutoff must be
identical: a later fact may not change what an earlier decision sees.
"""

from __future__ import annotations

import random
import unittest
from collections import Counter
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from pandas.testing import assert_frame_equal

from research_datasets import derived_fundamentals, fundamental_factors, valuation

NEW_YORK = ZoneInfo("America/New_York")
POLICIES = ("public_reconstructed", "observed_content")
SEEDS = (20261117, 20261118)
CUTOFFS_PER_POLICY = 4

# Base annual amounts; flows also get YTD and (for most tags) three-month facts.
FLOW = {
    "Revenues": 1000.0,
    "GrossProfit": 400.0,
    "OperatingIncomeLoss": 180.0,
    "NetIncomeLoss": 120.0,
    "DepreciationDepletionAndAmortization": 50.0,
    "NetCashProvidedByUsedInOperatingActivities": 200.0,
    "PaymentsToAcquirePropertyPlantAndEquipment": 60.0,
    "PaymentsOfDividendsCommonStock": 30.0,
    "PaymentsForRepurchaseOfCommonStock": 40.0,
    "ProceedsFromIssuanceOfCommonStock": 10.0,
}
# Cash-flow statements report year-to-date periods only.
YTD_ONLY = frozenset(
    {
        "NetCashProvidedByUsedInOperatingActivities",
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsOfDividendsCommonStock",
        "PaymentsForRepurchaseOfCommonStock",
        "ProceedsFromIssuanceOfCommonStock",
    }
)
INSTANT = {
    "Assets": 5000.0,
    "AssetsCurrent": 1500.0,
    "LiabilitiesCurrent": 800.0,
    "Liabilities": 3000.0,
    "StockholdersEquity": 2000.0,
    "CashAndCashEquivalentsAtCarryingValue": 300.0,
    "DebtCurrent": 100.0,
    "LongTermDebtNoncurrent": 900.0,
}


def new_york(day: date, hour: int, minute: int) -> pd.Timestamp:
    return pd.Timestamp(datetime.combine(day, time(hour, minute), NEW_YORK)).tz_convert(
        "UTC"
    )


def iso(value: pd.Timestamp) -> str:
    return value.isoformat().replace("+00:00", "Z")


def weekday(day: date) -> date:
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day


class Issuer:
    """One synthetic SEC filer: quarterly, twelve-week (52/53-week) or annual-only."""

    def __init__(self, rng: random.Random, cik: str, kind: str) -> None:
        self.rng, self.cik, self.kind = rng, cik, kind
        self.rows: list[dict[str, Any]] = []
        self.filings = 0

    def filing(self, period_end: date, lag_days: int) -> tuple[pd.Timestamp, str]:
        day = weekday(period_end + timedelta(days=lag_days + self.rng.randint(0, 6)))
        # A quarter of the filings are public exactly at a 06:00 decision instant.
        if self.rng.random() < 0.25:
            hour, minute = 6, 0
        else:
            hour, minute = self.rng.randint(6, 19), self.rng.choice((0, 15, 30, 59))
        self.filings += 1
        return new_york(day, hour, minute), f"{self.cik}-{self.filings:04d}"

    def emit(
        self,
        tag: str,
        value: float,
        start: date | None,
        end: date,
        form: str,
        public: pd.Timestamp,
        accession: str,
        *,
        taxonomy: str = "us-gaap",
        unit: str = "USD",
    ) -> None:
        rng = self.rng
        filed = public.tz_convert(NEW_YORK).date().isoformat()
        observed = public + timedelta(hours=rng.choice((0, 0, 1, 2, 5, 30)))
        row = {
            "fact_id": f"{accession}:{tag}:{start}:{end}",
            "cik": self.cik,
            "metric": tag,
            "source": "sec",
            "taxonomy": taxonomy,
            "tag": tag,
            "tag_priority": 1,
            "unit": unit,
            "currency": "" if unit == "shares" else "USD",
            "period_start": None if start is None else start.isoformat(),
            "period_end": end.isoformat(),
            "period_kind": "instant" if start is None else "duration",
            "form": form,
            "accession": accession,
            "filed": filed,
            "public_at": iso(public),
            "public_date": filed,
            "public_time_precision": "second",
        }

        def observation(sequence: int, at: pd.Timestamp, amount: float | None) -> None:
            text = None
            if amount is not None:
                text = str(int(amount)) if unit == "shares" else f"{amount:.2f}"
            self.rows.append(
                {
                    **row,
                    "value": text,
                    "observed_at": iso(at),
                    "content_first_seen_at": iso(at),
                    "observation_sequence": sequence,
                    "is_retracted": amount is None,
                }
            )

        observation(1, observed, value)
        roll = rng.random()
        if roll < 0.06:  # a later observation of the same fact corrects its value
            later = observed + timedelta(days=rng.choice((1, 3, 20)))
            observation(2, later, value * rng.choice((0.9, 1.1, 1.5)))
        elif roll < 0.09:  # a later observation retracts it
            observation(2, observed + timedelta(days=rng.choice((2, 40))), None)

    def amount(self, tag: str, year: int, share: float) -> float:
        base = FLOW.get(tag) or INSTANT[tag]
        return round(base * (1 + 0.08 * year) * share * self.rng.uniform(0.9, 1.1), 2)

    def history(self, first_start: date, years: int) -> None:
        rng, twelve = self.rng, self.kind == "twelve_week"
        start, prior = first_start, None
        for year in range(years):
            if twelve:
                length = rng.choice((364, 371))
                ends = [start + timedelta(days=d - 1) for d in (84, 168, 252, length)]
            else:
                ends = []
                for months in (3, 6, 9, 12):
                    y, m = divmod(start.month - 1 + months, 12)
                    ends.append(date(start.year + y, m + 1, 1) - timedelta(days=1))
            reported: dict[tuple[str, date, date], float] = {}
            quarters = [3] if self.kind == "annual_only" else [0, 1, 2, 3]
            for q in quarters:
                end, annual = ends[q], q == 3
                if annual:
                    form = "10-K"
                    if self.kind == "annual_only" and rng.random() < 0.5:
                        form = "20-F"
                    lag = 120 if self.kind == "annual_only" else 60
                else:
                    form, lag = "10-Q", 35
                public, accession = self.filing(end, lag)
                q_start = start if q == 0 else ends[q - 1] + timedelta(days=1)
                for tag in FLOW:
                    if rng.random() < 0.05:
                        continue  # a tag missing from this filing
                    ytd = self.amount(tag, year, (q + 1) / 4)
                    reported[(tag, start, end)] = ytd
                    if annual or q > 0 or twelve or tag in YTD_ONLY:
                        self.emit(tag, ytd, start, end, form, public, accession)
                    three_month = not (annual or twelve or tag in YTD_ONLY)
                    if three_month and (q == 0 or rng.random() < 0.8):
                        self.emit(
                            tag, ytd / (q + 1), q_start, end, form, public, accession
                        )
                    # The prior-year comparative, sometimes restated.
                    if prior is not None and rng.random() < 0.7:
                        key = (tag, prior[0], prior[1][q])
                        if key in prior[2]:
                            restated = prior[2][key] * rng.choice((1, 1, 1, 0.95, 1.2))
                            self.emit(
                                tag, restated, key[1], key[2], form, public, accession
                            )
                for tag in INSTANT:
                    if rng.random() < 0.05:
                        continue
                    self.emit(
                        tag,
                        self.amount(tag, year, 1.0),
                        None,
                        end,
                        form,
                        public,
                        accession,
                    )
                if annual or not twelve:
                    self.emit(
                        "EarningsPerShareDiluted",
                        round(rng.uniform(-0.5, 2.0), 2),
                        start if annual else q_start,
                        end,
                        form,
                        public,
                        accession,
                        unit="USD/shares",
                    )
                self.emit(
                    "WeightedAverageNumberOfSharesOutstandingBasic",
                    990_000 * (1 + 0.02 * year),
                    start if annual else q_start,
                    end,
                    form,
                    public,
                    accession,
                    unit="shares",
                )
                if rng.random() < 0.9:  # cover shares as of a few days before filing
                    as_of = public.tz_convert(NEW_YORK).date()
                    self.emit(
                        "EntityCommonStockSharesOutstanding",
                        1_000_000 * (1 + 0.02 * year) * rng.uniform(0.98, 1.02),
                        None,
                        as_of - timedelta(days=rng.randint(3, 10)),
                        form,
                        public,
                        accession,
                        taxonomy="dei",
                        unit="shares",
                    )
                if rng.random() < 0.15:  # an amendment restates this period later
                    public_a, accession_a = self.filing(end, lag + rng.choice((20, 90)))
                    tag = rng.choice(list(FLOW))
                    value = reported.get((tag, start, end), 100.0) * 1.07
                    self.emit(
                        tag, value, start, end, f"{form}/A", public_a, accession_a
                    )
            prior = (start, ends, reported)
            start = ends[3] + timedelta(days=1)


def asset(number: int) -> str:
    return f"00000000-0000-4000-8000-{number:012d}"


def random_material(seed: int) -> tuple[dict[str, Any], pd.DataFrame, pd.DataFrame]:
    """Facts of four issuers (the fourth files its first report a year later), raw
    closes, one split and weekly samples decided at 06:00 New York."""
    rng = random.Random(seed)
    kinds = ["quarterly", "twelve_week", "annual_only"]
    kinds.append(rng.choice(kinds))
    first_starts = {
        "quarterly": date(2020, rng.choice((1, 4, 7, 10)), 1),
        "twelve_week": date(2020, 8, 31) - timedelta(days=rng.randint(0, 6)),
        "annual_only": date(2020, rng.choice((1, 7)), 1),
    }
    rows: list[dict[str, Any]] = []
    universe = []
    for number, kind in enumerate(kinds, start=1):
        cik = f"{number:010d}"
        first = first_starts[kind]
        if number == 4:  # a later first filer: one fiscal year later
            if kind == "twelve_week":
                first += timedelta(days=364)
            else:
                first = first.replace(year=first.year + 1)
        issuer = Issuer(rng, cik, kind)
        issuer.history(first, 3)
        rows.extend(issuer.rows)
        universe.append(
            {
                "asset_id": asset(number),
                "symbol": f"S{number}",
                "cik": cik,
                "issuer_mapping_status": "verified",
            }
        )
    days = pd.bdate_range("2020-03-02", "2024-06-28").date.tolist()
    closes = []
    for row in universe:
        price = 50.0
        for day in days:
            price = max(1.0, price * (1 + rng.gauss(0, 0.01)))
            closes.append(
                {"asset_id": row["asset_id"], "date": day.isoformat(), "close": price}
            )
    material = {
        "manifest": {
            "calendar": [day.isoformat() for day in days],
            "source_timezones": {"sec": "America/New_York"},
        },
        "universe": pd.DataFrame(universe),
        "fundamentals": pd.DataFrame(rows),
        "raw": pd.DataFrame(closes),
    }
    splits = pd.DataFrame(
        [
            {
                "asset_id": asset(1),
                "ex_date": "2022-06-15",
                "ratio_new_per_old": 2.0,
                "status": "ok",
            }
        ]
    )
    samples = pd.DataFrame(
        [
            {
                "asset_id": row["asset_id"],
                "signal_session": days[index],
                "decision_at": new_york(days[index + 1], 6, 0),
            }
            for row in universe
            for index in range(0, len(days) - 1, 5)
        ]
    )
    return material, samples, splits


def available_at(facts: pd.DataFrame, time_policy: str) -> pd.Series:
    """Independent oracle for these facts: public_at (on or after 06:00 New York of its
    filing date), or under observed_content max(public_at, observed_at - 3 h)."""
    public = pd.to_datetime(facts["public_at"], utc=True)
    if time_policy == "public_reconstructed":
        return public
    observed = pd.to_datetime(facts["observed_at"], utc=True) - timedelta(hours=3)
    return public.where(public >= observed, observed)


def outputs(
    material: dict[str, Any],
    samples: pd.DataFrame,
    splits: pd.DataFrame,
    time_policy: str,
) -> dict[str, pd.DataFrame]:
    derived = derived_fundamentals(
        material, samples, time_policy=time_policy, provenance=True
    )
    return {
        "derived": derived,
        "factors": fundamental_factors(derived),
        "valuation": valuation(
            material,
            samples,
            derived,
            time_policy=time_policy,
            split_events=splits,
            provenance=True,
        ),
    }


class TruncationInvarianceTest(unittest.TestCase):
    def test_outputs_ignore_facts_available_after_the_cutoff(self) -> None:
        for seed in SEEDS:
            material, samples, splits = random_material(seed)
            facts = material["fundamentals"]
            decisions = samples["decision_at"]
            with self.subTest(seed=seed, check="history"):
                values = facts[~facts["is_retracted"]].groupby(
                    ["cik", "tag", "period_start", "period_end"], dropna=False
                )["value"]
                self.assertGreater(int((values.nunique() > 1).sum()), 0)  # restated
                retracted = int(facts["is_retracted"].sum())
                self.assertGreater(retracted, 0)
                corrected = int((facts["observation_sequence"] == 2).sum()) - retracted
                self.assertGreater(corrected, 0)
                self.assertTrue(facts["form"].str.endswith("/A").any())  # amendments
            for time_policy in POLICIES:
                full = outputs(material, samples, splits, time_policy)
                self.assert_cases_covered(full, seed, time_policy)
                clocks = available_at(facts, time_policy)
                rng = random.Random(f"{seed}:{time_policy}")
                # Fact clocks (kept: available_at == cutoff) and decision instants.
                picks = rng.sample(sorted(set(clocks)), CUTOFFS_PER_POLICY - 1)
                picks += rng.sample(sorted(set(decisions)), 1)
                for cutoff in sorted(set(picks)):
                    past = (decisions <= cutoff).to_numpy()
                    if not past.any():
                        continue
                    kept = (clocks <= cutoff).to_numpy()
                    truncated = outputs(
                        {
                            **material,
                            "fundamentals": facts[kept].reset_index(drop=True),
                        },
                        samples[past].reset_index(drop=True),
                        splits,
                        time_policy,
                    )
                    for name, frame in full.items():
                        with self.subTest(
                            seed=seed, policy=time_policy, cutoff=str(cutoff), out=name
                        ):
                            assert_frame_equal(
                                frame[past].reset_index(drop=True), truncated[name]
                            )

    def assert_cases_covered(
        self, full: dict[str, pd.DataFrame], seed: int, time_policy: str
    ) -> None:
        """The histories must reach the paths this guard is about."""
        derived, value = full["derived"], full["valuation"]
        statuses = Counter(
            str(status)
            for column in derived.columns
            if column.endswith("_status")
            for status in derived[column]
        )
        bases = Counter(
            str(basis)
            for column in derived.columns
            if column.endswith("_basis")
            for basis in derived[column].dropna()
        )
        with self.subTest(seed=seed, policy=time_policy, check="coverage"):
            for status in ("ok", "approximate", "annual_only", "stale"):
                self.assertGreater(statuses[status], 0, status)
            for basis in ("ytd_difference", "fy_minus_ytd", "fiscal_year", "cover"):
                self.assertGreater(bases[basis], 0, basis)
            self.assertNotIn("not_yet_available", statuses)
            for name in ("market_cap_issuer", "net_payout_yield", "net_issuance_1y"):
                self.assertTrue(
                    np.isfinite(value[f"{name}_value"].to_numpy(dtype=float)).any(),
                    name,
                )


if __name__ == "__main__":
    unittest.main()
