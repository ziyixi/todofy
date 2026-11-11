"""Manual benchmark of the 2.0 reader on synthetic data; not part of the test suite.

Run from ``packages/research-datasets`` with the SDK importable::

    python -m tests.bench_panel              # 1,100 securities x 2,700 sessions
    python -m tests.bench_panel 100 300      # a quick smoke run

It holds about 2 M event observation versions and 1.6 M fact versions in memory, then
prints the time of event features, fundamentals, a weekly and a daily panel, and the
peak resident memory so far (the synthetic inputs included). Targets on a Colab CPU:
event features <= 3 min, fundamentals <= 6 min, weekly panel <= 5 min and 6 GB, daily
panel <= 15 min and 9 GB.
"""

from __future__ import annotations

import resource
import sys
import time
from collections.abc import Callable, Sequence
from typing import Any

import numpy as np
import pandas as pd

import research_datasets
from research_datasets import fundamentals

POLICY = "public_reconstructed"
HORIZONS = (21, 63, 126)
NANOSECOND = np.timedelta64(1, "ns")


def uuid(number: int) -> str:
    return f"00000000-0000-4000-8000-{number:012d}"


def iso(instants: np.ndarray) -> np.ndarray:
    """Nanosecond UTC instants as ISO strings with a Z suffix."""
    text = np.datetime_as_string(instants.astype("datetime64[s]"), unit="s")
    return np.char.add(text.astype(str), "Z").astype(object)


class BenchVersion:
    """An in-memory frozen version with every family the panel reads."""

    def __init__(self, securities: int, sessions: int, seed: int = 0) -> None:
        rng = np.random.default_rng(seed)
        days = pd.bdate_range("2016-01-04", periods=sessions)
        self.id, self.manifest_sha256 = uuid(0), "0" * 64
        self.calendar = [day.date().isoformat() for day in days]
        self.ids = [uuid(n + 1) for n in range(securities)]
        bench = uuid(securities + 1)
        # Every tenth security shares its issuer with the previous one (share classes).
        ciks = [f"{n - (n % 10 == 9) + 1:010d}" for n in range(securities)]
        self.universe = pd.DataFrame(
            {
                "asset_id": [*self.ids, bench],
                "symbol": [f"S{n}" for n in range(securities)] + ["BENCH"],
                "cik": [*ciks, ""],
                "issuer_mapping_status": ["verified"] * securities + ["unknown"],
                "security_type": "common",
                "is_benchmark": [False] * securities + [True],
            }
        )
        months = sorted({day[:7] for day in self.calendar})
        self.manifest = {
            "dataset_id": self.id,
            "cutoff_date": self.calendar[-1],
            "source_timezones": {"sec": "America/New_York"},
            "data_families": {
                "universe_membership": {"schema_version": 1},
                "daily_returns": {"schema_version": 1},
            },
            "universe_rule": {
                "first_effective_month": months[0],
                "last_effective_month": months[-1],
            },
        }
        everyone = [*self.ids, bench]
        stamp = days.values.astype("datetime64[ns]")
        closes = 50 * np.exp(
            np.cumsum(rng.normal(0, 0.02, (len(everyone), sessions)), axis=1)
        )
        self.prices_frame = pd.DataFrame(
            {
                "asset_id": np.repeat(everyone, sessions),
                "date": np.tile(self.calendar, len(everyone)),
                "open": (closes * 0.999).ravel(),
                "close": closes.ravel(),
                "volume": rng.integers(10**5, 10**7, closes.size).astype(float),
            }
        )
        self.frames = {
            "daily_returns": pd.DataFrame(
                {
                    "asset_id": self.prices_frame["asset_id"],
                    "date": self.prices_frame["date"],
                    "row_kind": "session",
                    "open_raw": self.prices_frame["open"],
                    "close_raw": self.prices_frame["close"],
                    "tr_index": (closes / closes[:, :1]).ravel(),
                    "tr_status": np.where(
                        rng.random(closes.size) < 0.001, "disputed", "ok"
                    ),
                    "terminal_basis": "",
                    "cash_amount": 0.0,
                }
            ),
            "universe_membership": pd.DataFrame(
                {
                    "rule_version": research_datasets.DEFAULT_UNIVERSE_RULE,
                    "effective_month": np.repeat(months, securities),
                    "asset_id": np.tile(self.ids, len(months)),
                    "member": rng.random(len(months) * securities) < 0.92,
                    "warmup": False,
                    "observation_sequence": 1,
                }
            ),
        }
        self.observations = self._observations(rng, stamp)
        self.checks = self._checks(months)
        self.facts = self._facts(rng, ciks, stamp)

    def _observations(
        self, rng: np.random.Generator, stamp: np.ndarray
    ) -> pd.DataFrame:
        """About 1,800 events per security, a tenth of them revised once."""
        events = len(self.ids) * 1650
        asset = rng.integers(0, len(self.ids), events)
        source = rng.choice(
            ["sec", "alpaca_news", "finnhub_news"], events, p=[0.2, 0.5, 0.3]
        )
        public = (
            stamp[rng.integers(0, len(stamp), events)]
            + (rng.integers(0, 24 * 3600, events) * 10**9) * NANOSECOND
        )
        revised = np.flatnonzero(rng.random(events) < 0.1)
        index = np.concatenate([np.arange(events), revised])
        sequence = np.concatenate([np.ones(events, int), np.full(len(revised), 2)])
        recorded = public[index] + (sequence * 3600 * 10**9) * NANOSECOND
        recorded_text = iso(recorded)
        owner = np.asarray(self.ids, dtype=object)[asset[index]]
        uids = np.char.add("e", index.astype(str)).astype(object)
        return pd.DataFrame(
            {
                "source": source[index],
                "event_uid": uids,
                "event_id": uids,
                "observation_sequence": sequence,
                "form": rng.choice(["8-K", "10-Q", "4"], len(index)),
                "items": "",
                "filing_date": "",
                "event_date": iso(public[index])
                .astype(str)
                .astype("<U10")
                .astype(object),
                "asset_ids": [[item] for item in owner],
                "asset_first_seen_at": [
                    {item: clock}
                    for item, clock in zip(owner, recorded_text, strict=True)
                ],
                "content_first_seen_at": recorded_text,
                "observation_recorded_at": recorded_text,
                "public_time_precision": "second",
                "public_at": iso(public[index]),
                "public_date": "",
                "story_key": "",
            }
        )

    def _checks(self, months: Sequence[str]) -> pd.DataFrame:
        """One complete check per security, source and month."""
        starts = [f"{month}-01" for month in months]
        ends = [
            (pd.Timestamp(start) + pd.offsets.MonthEnd(0)).date().isoformat()
            for start in starts
        ]
        cells = len(self.ids) * len(months)
        frames = [
            pd.DataFrame(
                {
                    "source": source,
                    "asset_id": np.repeat(self.ids, len(months)),
                    "checked_start": np.tile(starts, len(self.ids)),
                    "checked_end": np.tile(ends, len(self.ids)),
                    "checked_at": "2026-11-01T00:00:00Z",
                    "status": "checked",
                    "error_code": "",
                    "count": np.ones(cells, int),
                }
            )
            for source in ("sec", "alpaca_news", "finnhub_news")
        ]
        return pd.concat(frames, ignore_index=True)

    def _facts(
        self, rng: np.random.Generator, ciks: Sequence[str], stamp: np.ndarray
    ) -> pd.DataFrame:
        """Quarterly filings per issuer: current and prior-year values of every metric,
        a fifth of them saved twice."""
        issuers = sorted(set(ciks))
        quarters = pd.date_range(
            stamp[0] - np.timedelta64(400, "D"), stamp[-1], freq="QE"
        )
        metrics = list(research_datasets.ALL_METRICS)
        units = list(research_datasets.ALL_METRICS.values())
        instant = np.isin(metrics, list(research_datasets.INSTANT_METRICS))
        grid = np.array(
            np.meshgrid(
                np.arange(len(issuers)),
                np.arange(len(quarters)),
                np.arange(len(metrics)),
                [0, 1],
            ),
        ).reshape(4, -1)
        issuer, quarter, metric, prior = grid
        ends = quarters.values[quarter] - (prior * 365) * np.timedelta64(1, "D")
        q4 = quarters.month.values[quarter] == 12
        kind = np.where(instant[metric], "instant", np.where(q4, "annual", "quarter"))
        length = np.where(kind == "annual", 364, 90) * np.timedelta64(1, "D")
        public = (
            quarters.values[quarter]
            + (rng.integers(25, 60, len(issuer)) * 86400 * 10**9) * NANOSECOND
        )
        accession = np.char.add(
            np.asarray(issuers)[issuer].astype(str), quarter.astype(str)
        )
        saved = np.concatenate(
            [np.arange(len(issuer)), np.flatnonzero(rng.random(len(issuer)) < 0.2)]
        )
        sequence = np.concatenate(
            [np.ones(len(issuer), int), np.full(len(saved) - len(issuer), 2)]
        )
        public_text = iso(public[saved])
        return pd.DataFrame(
            {
                "fact_id": np.char.add("f", saved.astype(str)).astype(object),
                "cik": np.asarray(issuers, dtype=object)[issuer[saved]],
                "metric": np.asarray(metrics, dtype=object)[metric[saved]],
                "source": "sec",
                "tag": np.asarray(metrics, dtype=object)[metric[saved]],
                "tag_priority": 0,
                "unit": np.asarray(units, dtype=object)[metric[saved]],
                "currency": "USD",
                "value": rng.integers(1, 10**9, len(saved)).astype(str).astype(object),
                "period_start": np.datetime_as_string(
                    ends[saved] - length[saved], "D"
                ).astype(object),
                "period_end": np.datetime_as_string(ends[saved], "D").astype(object),
                "period_kind": kind[saved].astype(object),
                "accession": accession[saved].astype(object),
                "public_at": public_text,
                "public_date": public_text.astype(str).astype("<U10").astype(object),
                "filed": public_text.astype(str).astype("<U10").astype(object),
                "public_time_precision": "second",
                "observed_at": iso(
                    public[saved] + (sequence * 86400 * 10**9) * NANOSECOND
                ),
                "observation_sequence": sequence,
                "is_retracted": False,
            }
        )

    # --- the reader interface the panel uses --------------------------------------

    def resolve(self, symbols: Any) -> list[str]:
        ids = list(self.universe["asset_id"])
        if symbols is None or symbols == "all":
            return ids
        named = dict(
            zip(self.universe["symbol"], self.universe["asset_id"], strict=True)
        )
        values = [symbols] if isinstance(symbols, str) else list(symbols)
        return [named.get(value, value) for value in values]

    def prices(self, asset_ids: Sequence[str], adjusted: bool = True) -> pd.DataFrame:
        return self.prices_frame[self.prices_frame["asset_id"].isin(list(asset_ids))]

    def event_observations(self, columns: Sequence[str] | None = None) -> pd.DataFrame:
        return self.observations

    def source_checks(self, asset_ids: Sequence[str]) -> pd.DataFrame:
        return self.checks[self.checks["asset_id"].isin(list(asset_ids))]

    def family(
        self,
        name: str,
        symbols: Any = None,
        start: Any = None,
        end: Any = None,
        *,
        columns: Any = None,
    ) -> pd.DataFrame:
        frame = self.frames[name]
        frame = frame[frame["asset_id"].isin(self.resolve(symbols))]
        return frame[list(columns)] if columns else frame

    def fundamentals(
        self, asset_ids: Sequence[str], metrics: Sequence[str] | None = None
    ) -> pd.DataFrame:
        wanted = set(self.universe.set_index("asset_id").loc[list(asset_ids), "cik"])
        frame = self.facts[self.facts["cik"].isin(wanted)]
        return frame[frame["metric"].isin(metrics)] if metrics else frame


def peak_gb() -> float:
    scale = 1 if sys.platform == "darwin" else 1024
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * scale / 1e9


def timed(label: str, call: Callable[[], pd.DataFrame]) -> pd.DataFrame:
    began = time.perf_counter()
    result = call()
    print(
        f"{label}: {time.perf_counter() - began:.1f} s, {len(result):,} rows x "
        f"{result.shape[1]} columns, peak RSS {peak_gb():.1f} GB",
        flush=True,
    )
    return result


def main(argv: Sequence[str]) -> None:
    securities = int(argv[0]) if argv else 1100
    sessions = int(argv[1]) if len(argv) > 1 else 2700
    began = time.perf_counter()
    version = BenchVersion(securities, sessions)
    print(
        f"inputs: {len(version.observations):,} observation versions, "
        f"{len(version.facts):,} fact versions, {len(version.checks):,} checks in "
        f"{time.perf_counter() - began:.1f} s, peak RSS {peak_gb():.1f} GB",
        flush=True,
    )
    daily = timed(
        "event and price features, daily",
        lambda: research_datasets.daily_features(
            version, version.ids, time_policy=POLICY, benchmark="BENCH"
        ),
    )
    samples = daily[["asset_id", "signal_session", "decision_at"]].copy()
    del daily
    metrics = {
        kind: fundamentals.default_metrics(kind)
        for kind in ("quarter", "annual", "instant")
    }
    timed(
        "fundamental features and ratios, daily",
        lambda: pd.concat(
            [
                fundamentals.features_by_period(
                    version, samples, metrics, time_policy=POLICY, provenance=False
                ),
                fundamentals.ratios_by_period(
                    version,
                    samples,
                    ("quarter", "annual"),
                    currency="USD",
                    time_policy=POLICY,
                    provenance=False,
                ),
            ],
            axis=1,
        ),
    )
    for sampling in ("weekly", "daily"):
        timed(
            f"panel, {sampling}",
            lambda sampling=sampling: research_datasets.panel(
                version,
                version.ids,
                time_policy=POLICY,
                benchmark="BENCH",
                sampling=sampling,
                horizons=HORIZONS,
            ),
        )


if __name__ == "__main__":
    main(sys.argv[1:])
