"""Forward-return labels: horizons, total return, exits, disputes, splits, neutralization."""

from __future__ import annotations

import tempfile
import unittest
from collections.abc import Mapping, Sequence
from datetime import date
from typing import Any

import numpy as np
import pandas as pd
from pandas.testing import assert_frame_equal

import research_datasets
from tests import test_sdk as bundle
from tests.reference import reference_labels

DATASET = "00000000-0000-4000-8000-0000000000aa"
BENCH = "00000000-0000-4000-8000-0000000000b0"
SESSIONS = pd.bdate_range("2026-01-05", periods=40).date.tolist()
POLICY = dict(research_datasets.DEFAULT_TERMINAL_POLICY)


def asset(number: int) -> str:
    return f"00000000-0000-4000-8000-{number:012d}"


A, B, HEIR = asset(1), asset(2), asset(3)


def session_rows(
    asset_id: str,
    closes: Sequence[float],
    *,
    days: Sequence[date] = SESSIONS,
    opens: Sequence[float] | None = None,
    status: Mapping[int, str] | None = None,
    skip: Sequence[int] = (),
) -> list[dict[str, Any]]:
    """daily_returns rows without actions: tr_index = close / first close."""
    rows = []
    for index, close in enumerate(closes):
        if index in skip:
            continue
        rows.append(
            {
                "asset_id": asset_id,
                "date": days[index].isoformat(),
                "row_kind": "first" if not rows else "session",
                "open_raw": (opens[index] if opens is not None else close - 0.5),
                "close_raw": close,
                "tr_index": close / closes[0],
                "tr_status": (status or {}).get(index, "first" if not rows else "ok"),
                "terminal_basis": "",
                "cash_amount": 0.0,
            }
        )
    return rows


def terminal_row(
    asset_id: str, at: int, basis: str, level: float, cash: float = 0.0
) -> dict[str, Any]:
    return {
        "asset_id": asset_id,
        "date": SESSIONS[at].isoformat(),
        "row_kind": "terminal",
        "open_raw": None,
        "close_raw": None,
        "tr_index": level,
        "tr_status": "terminal",
        "terminal_basis": basis,
        "cash_amount": cash,
    }


def exit_row(
    asset_id: str, kind: str, successor: str = "", sequence: int = 1
) -> dict[str, Any]:
    return {
        "asset_id": asset_id,
        "exit_type": kind,
        "successor_asset_id": successor,
        "observation_sequence": sequence,
    }


class LabelVersion:
    """A frozen version over in-memory families, filtered like the client."""

    def __init__(
        self,
        assets: Sequence[str],
        *,
        days: Sequence[date] = SESSIONS,
        families: Mapping[str, list[dict[str, Any]]] | None = None,
        prices: pd.DataFrame | None = None,
        universe: Sequence[Mapping[str, Any]] | None = None,
        manifest: Mapping[str, Any] | None = None,
    ) -> None:
        self.id = DATASET
        self.calendar = [value.isoformat() for value in days]
        self.universe = pd.DataFrame(
            universe
            or [{"asset_id": item, "symbol": f"S{n}"} for n, item in enumerate(assets)]
        )
        self.frames = {
            name: pd.DataFrame(rows) for name, rows in (families or {}).items()
        }
        self.manifest = {
            "dataset_id": DATASET,
            "cutoff_date": self.calendar[-1],
            "data_families": {name: {"schema_version": 1} for name in self.frames},
            **(manifest or {}),
        }
        self.manifest_sha256 = "0" * 64
        self.price_rows = prices
        self.reads: list[tuple[str, tuple[str, ...], Any, Any]] = []

    def resolve(self, symbols: Any) -> list[str]:
        ids = list(self.universe["asset_id"])
        if symbols is None or symbols == "all":
            return ids
        by_symbol = dict(zip(self.universe["symbol"], self.universe["asset_id"]))
        values = [symbols] if isinstance(symbols, str) else list(symbols)
        return [by_symbol.get(value, value) for value in values]

    def prices(self, asset_ids: Sequence[str], adjusted: bool = True) -> pd.DataFrame:
        frame = self.price_rows
        return frame[frame["asset_id"].isin(list(asset_ids))].copy()

    def family(
        self,
        name: str,
        symbols: Any = None,
        start: Any = None,
        end: Any = None,
        *,
        columns: Any = None,
    ) -> pd.DataFrame:
        ids = tuple(self.resolve(symbols))
        self.reads.append((name, ids, start, end))
        frame = self.frames[name]
        frame = frame[frame["asset_id"].isin(ids)]
        if name == "daily_returns" and (start or end):
            day = frame["date"].astype(str)
            frame = frame[(day >= (start or "")) & (day <= (end or "9999"))]
        return frame[list(columns) if columns else frame.columns].copy()


def benchmark_rows(days: Sequence[date] = SESSIONS) -> list[dict[str, Any]]:
    return session_rows(BENCH, [400.0 + 2 * i for i in range(len(days))], days=days)


def labels_for(
    version: LabelVersion, rows: Sequence[tuple[str, int]], horizon: int, **options: Any
) -> pd.DataFrame:
    samples = pd.DataFrame(
        {
            "asset_id": [item for item, _ in rows],
            "signal_session": [SESSIONS[i] for _, i in rows],
        }
    )
    return research_datasets.forward_returns(
        version,
        samples,
        benchmark=BENCH,
        horizons=horizon,
        allow_static_universe=True,
        **options,
    )


def random_material(seed: int) -> dict[str, Any]:
    """Prices with gaps, vendor/disputed sessions and one exit of each kind."""
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2025-01-06", periods=160).date.tolist()
    ids = [asset(10 + n) for n in range(8)]
    daily, prices, exits = [], [], []
    bases = [
        "cash",
        "worthless",
        "last_close_proxy",
        "acquirer_close",
        "cash_and_acquirer_close",
        "unknown",
        "unknown",
    ]
    kinds = [
        "cash_merger",
        "unknown",
        "",
        "stock_merger",
        "cash_merger",
        "performance",
        "unknown",
    ]
    for n, item in enumerate([*ids, BENCH, HEIR]):
        closes = 50 * np.exp(np.cumsum(rng.normal(0, 0.02, len(days))))
        opens = closes * np.exp(rng.normal(0, 0.01, len(days)))
        skip = set(rng.choice(len(days), size=int(rng.integers(0, 8)), replace=False))
        status = {
            int(k): str(rng.choice(["vendor", "disputed"]))
            for k in rng.choice(len(days), size=4, replace=False)
        }
        end = len(days)
        if n < len(bases):
            end = int(rng.integers(20, len(days) - 5))
            basis = bases[n]
            value = (
                0.0
                if basis == "worthless"
                else float("nan")
                if basis == "unknown"
                else closes[end - 1] / closes[0] * float(rng.uniform(0.8, 1.4))
            )
            kind = kinds[n]
            cash = float(rng.uniform(1, 30)) if basis.startswith("cash") else 0.0
            daily.append(
                {
                    **terminal_row(item, 0, basis, value, cash),
                    "date": days[end].isoformat(),
                }
            )
            exits.append(exit_row(item, kind, HEIR if "acquirer" in basis else ""))
        rows = session_rows(
            item,
            list(closes[:end]),
            days=days,
            opens=list(opens[:end]),
            status=status,
            skip=sorted(skip),
        )
        daily.extend(rows)
        prices.extend(
            {
                "asset_id": row["asset_id"],
                "date": row["date"],
                "open": row["open_raw"] * (1 - 0.01 * (n % 3)),
                "close": row["close_raw"] * (1 - 0.01 * (n % 3)),
                "volume": 1.0,
            }
            for row in rows
        )
    return {
        "days": days,
        "ids": ids,
        "daily": pd.DataFrame(daily),
        "prices": pd.DataFrame(prices),
        "delistings": pd.DataFrame(exits),
    }


class HorizonTest(unittest.TestCase):
    COLUMNS = (
        "asset_return",
        "benchmark_return",
        "excess_return",
        "pair_valid",
        "horizon_beyond_material",
        "entry_price_missing",
        "exit_price_missing",
        "benchmark_missing",
        "interior_missing_sessions",
        "disputed_sessions",
        "return_status",
        "delisted_in_window",
        "terminal_basis",
        "terminal_unknown",
        "post_exit_basis",
        "post_exit_sessions",
    )

    def test_any_horizon_entry_open_exit_close(self) -> None:
        horizons = (1, 21, 63, 126)
        for seed in range(6):
            material = random_material(seed)
            days, ids = material["days"], material["ids"]
            families = {
                "daily_returns": material["daily"].to_dict("records"),
                "delistings": material["delistings"].to_dict("records"),
            }
            assets = [*ids, BENCH, HEIR]
            for basis in ("total_return", "vendor_adjusted"):
                version = LabelVersion(
                    assets,
                    days=days,
                    families=families if basis == "total_return" else None,
                    prices=material["prices"],
                    manifest={"cutoff_date": days[-3].isoformat()},
                )
                samples = pd.DataFrame(
                    [(item, day) for item in ids for day in days[:-1]],
                    columns=research_datasets.KEYS,
                )
                frame = research_datasets.forward_returns(
                    version,
                    samples,
                    benchmark=BENCH,
                    horizons=horizons,
                    allow_static_universe=True,
                )
                for horizon in horizons:
                    with self.subTest(seed=seed, basis=basis, horizon=horizon):
                        expected = pd.DataFrame(
                            reference_labels(
                                days,
                                days[-3],
                                samples.itertuples(index=False, name=None),
                                horizon,
                                BENCH,
                                daily=material["daily"]
                                if basis == "total_return"
                                else None,
                                prices=material["prices"],
                                delistings=material["delistings"]
                                if basis == "total_return"
                                else None,
                                policy=POLICY,
                            )
                        )
                        actual = frame[
                            [f"h{horizon}_{name}" for name in self.COLUMNS]
                        ].set_axis(list(self.COLUMNS), axis=1)
                        for name in (
                            "return_status",
                            "terminal_basis",
                            "post_exit_basis",
                        ):
                            actual[name] = actual[name].astype(str)
                        for name in (
                            "interior_missing_sessions",
                            "disputed_sessions",
                            "post_exit_sessions",
                        ):
                            actual[name] = actual[name].astype("Float64")
                            expected[name] = expected[name].astype("Float64")
                        assert_frame_equal(
                            actual, expected[list(self.COLUMNS)], check_dtype=False
                        )
                        self.assertEqual(
                            set(frame[f"h{horizon}_return_basis"]), {basis}
                        )
                if basis == "total_return":
                    # Not vacuous: exits of several kinds fall inside some windows.
                    kinds = set(frame["h21_terminal_basis"].astype(str)) - {""}
                    self.assertGreaterEqual(len(kinds), 4, kinds)
                    self.assertTrue(frame["h21_pair_valid"].any())
                    self.assertTrue((frame["h63_disputed_sessions"] > 0).any())

    def test_interior_gap_counted_exit_gap_masked(self) -> None:
        closes = [100.0 + i for i in range(len(SESSIONS))]
        version = LabelVersion(
            [A, BENCH],
            families={
                "daily_returns": session_rows(A, closes, skip=[7, 12])
                + benchmark_rows()
            },
        )
        frame = labels_for(version, [(A, 3), (A, 6)], 4)
        interior, exit_gap = frame.iloc[0], frame.iloc[1]
        # Window 4..7 for signal 3: the exit session 7 has no close -> masked.
        self.assertTrue(interior.exit_price_missing)
        self.assertFalse(interior.pair_valid)
        # Window 7..10 for signal 6: entry 7 missing.
        self.assertTrue(exit_gap.entry_price_missing)
        frame = labels_for(version, [(A, 5), (A, 10)], 5)
        # Signal 5: entry 6, exit 10, session 7 inside -> counted, label kept.
        self.assertEqual(frame.iloc[0].interior_missing_sessions, 1)
        self.assertTrue(frame.iloc[0].pair_valid)
        self.assertAlmostEqual(
            frame.iloc[0].asset_return, closes[10] / (closes[6] - 0.5) - 1
        )
        self.assertEqual(frame.iloc[1].interior_missing_sessions, 1)
        self.assertTrue(frame["trainable_5d"].all())


class ExitTest(unittest.TestCase):
    """Asset A trades sessions 0..9 and exits at session 10; windows 6..13."""

    LAST, EXIT = 9, 10
    CLOSES = tuple(50.0 + i for i in range(10))
    HEIR_CLOSES = tuple(20.0 + 0.5 * i for i in range(len(SESSIONS)))

    def run_exit(
        self,
        basis: str,
        level: float,
        *,
        cash: float = 0.0,
        kind: str = "cash_merger",
        heir: bool = True,
        **options: Any,
    ) -> pd.Series:
        rows = session_rows(A, list(self.CLOSES)) + benchmark_rows()
        rows.append(terminal_row(A, self.EXIT, basis, level, cash))
        if heir:
            rows += session_rows(HEIR, list(self.HEIR_CLOSES))
        version = LabelVersion(
            [A, BENCH, *([HEIR] if heir else [])],
            families={
                "daily_returns": rows,
                "delistings": [exit_row(A, kind, HEIR)],
            },
        )
        frame = labels_for(version, [(A, 5)], 8, **options)
        return frame.iloc[0]

    def entry(self) -> float:
        return (self.CLOSES[6] - 0.5) / self.CLOSES[0]

    def last_level(self) -> float:
        return self.CLOSES[self.LAST] / self.CLOSES[0]

    def test_terminal_cash_worthless_stock_successor_and_unknown(self) -> None:
        cash_level = self.last_level() * 1.1
        row = self.run_exit("cash", cash_level, cash=self.CLOSES[self.LAST] * 1.1)
        self.assertAlmostEqual(row.asset_return, cash_level / self.entry() - 1)
        self.assertEqual(
            (row.terminal_basis, row.post_exit_basis, row.post_exit_sessions),
            ("cash", "cash", 3),
        )
        self.assertTrue(row.delisted_in_window and row.return_reliable)
        row = self.run_exit("worthless", 0.0, kind="unknown")
        self.assertAlmostEqual(row.asset_return, -1.0)
        self.assertEqual(row.post_exit_basis, "worthless")
        self.assertTrue(row.trainable_8d)
        growth = self.HEIR_CLOSES[13] / self.HEIR_CLOSES[self.EXIT]
        row = self.run_exit("acquirer_close", 1.2, kind="stock_merger")
        self.assertAlmostEqual(row.asset_return, 1.2 * growth / self.entry() - 1)
        self.assertEqual(row.post_exit_basis, "successor")
        # Half the consideration in cash: only the stock half follows the successor.
        worth = 1.2 / self.last_level() * self.CLOSES[self.LAST]
        row = self.run_exit("cash_and_acquirer_close", 1.2, cash=worth / 2)
        self.assertAlmostEqual(
            row.asset_return, 1.2 * (0.5 + 0.5 * growth) / self.entry() - 1
        )
        self.assertEqual(row.post_exit_basis, "cash_and_successor")
        row = self.run_exit("unknown", float("nan"), kind="unknown")
        self.assertTrue(row.terminal_unknown)
        self.assertFalse(row.pair_valid or row.trainable_8d)
        self.assertTrue(np.isnan(row.asset_return))
        self.assertTrue(np.isfinite(row.benchmark_return))

    def test_performance_exit_assumption_is_flagged(self) -> None:
        row = self.run_exit("unknown", float("nan"), kind="performance")
        self.assertAlmostEqual(
            row.asset_return, self.last_level() * 0.7 / self.entry() - 1
        )
        self.assertEqual((row.terminal_basis, row.exit_type), ("policy", "performance"))
        self.assertEqual(row.post_exit_basis, "cash_proxy")
        self.assertTrue(row.pair_valid and row.trainable_8d)
        self.assertFalse(row.return_reliable)
        # The assumption is a parameter: None masks, a number replaces it.
        row = self.run_exit(
            "unknown",
            float("nan"),
            kind="performance",
            terminal_policy={"performance": None},
        )
        self.assertTrue(row.terminal_unknown)
        row = self.run_exit(
            "unknown",
            float("nan"),
            kind="performance",
            terminal_policy={"performance": -0.5},
        )
        self.assertAlmostEqual(
            row.asset_return, self.last_level() * 0.5 / self.entry() - 1
        )
        with self.assertRaisesRegex(ValueError, "terminal_policy"):
            self.run_exit("cash", 1.0, terminal_policy={"unknown": -2})

    def test_stock_merger_label_follows_successor_after_exit(self) -> None:
        row = self.run_exit("acquirer_close", 1.3, kind="stock_merger")
        growth = self.HEIR_CLOSES[13] / self.HEIR_CLOSES[self.EXIT]
        self.assertAlmostEqual(row.asset_return, 1.3 * growth / self.entry() - 1)
        self.assertEqual(
            (row.post_exit_basis, row.post_exit_sessions), ("successor", 3)
        )
        self.assertTrue(row.return_reliable)
        # The same exit without a frozen successor is held flat and flagged.
        row = self.run_exit("acquirer_close", 1.3, kind="stock_merger", heir=False)
        self.assertAlmostEqual(row.asset_return, 1.3 / self.entry() - 1)
        self.assertEqual(row.post_exit_basis, "cash_proxy")
        self.assertFalse(row.return_reliable)
        self.assertTrue(row.trainable_8d)

    def test_cash_merger_label_is_flat_after_exit_and_benchmark_spans_window(
        self,
    ) -> None:
        row = self.run_exit("cash", 1.25, cash=1.0)
        self.assertAlmostEqual(row.asset_return, 1.25 / self.entry() - 1)
        bench = [400.0 + 2 * i for i in range(len(SESSIONS))]
        # Benchmark: entry open of session 6 to the close of session 13 (past the exit).
        self.assertAlmostEqual(
            row.benchmark_return,
            (bench[13] / bench[0]) / ((bench[6] - 0.5) / bench[0]) - 1,
        )
        self.assertAlmostEqual(
            row.excess_return, row.asset_return - row.benchmark_return
        )
        self.assertEqual(row.exit_session, SESSIONS[13])
        self.assertEqual(row.interior_missing_sessions, 0)

    def test_disputed_session_excludes_label_from_trainable(self) -> None:
        closes = [100.0 + i for i in range(len(SESSIONS))]
        version = LabelVersion(
            [A, BENCH],
            families={
                "daily_returns": session_rows(
                    A, closes, status={8: "disputed", 15: "vendor"}
                )
                + benchmark_rows()
            },
        )
        frame = labels_for(version, [(A, 4), (A, 7), (A, 8), (A, 12)], 5)
        # Signal 4: (5, 9] holds 8; signal 7: entry session 8 itself is not in (8, 12].
        self.assertEqual(frame["disputed_sessions"].tolist(), [1, 0, 0, 0])
        self.assertEqual(
            frame["return_status"].astype(str).tolist(),
            ["disputed", "ok", "ok", "vendor"],
        )
        self.assertEqual(frame["trainable_5d"].tolist(), [False, True, True, True])
        self.assertTrue(frame["pair_valid"].all())
        self.assertFalse(frame.iloc[0].return_reliable)
        self.assertEqual(frame.attrs["masks"]["5"]["disputed_return"], 1)


class SplitTest(unittest.TestCase):
    def test_purge_and_embargo_any_horizon(self) -> None:
        closes = [100.0 + i for i in range(len(SESSIONS))]
        version = LabelVersion(
            [A, BENCH],
            families={"daily_returns": session_rows(A, closes) + benchmark_rows()},
        )
        cal = research_datasets.Calendar(SESSIONS)
        rows = [(A, i) for i in range(30)]
        validation_first = 15  # first validation signal
        for horizon, embargo, purged, embargoed in (
            (3, 0, 2, 0),
            (3, 5, 2, 3),
            (21, 5, 15, 0),
            (1, 2, 0, 2),
        ):
            with self.subTest(horizon=horizon, embargo=embargo):
                frame = labels_for(version, rows, horizon).assign(
                    decision_at=[cal.decision_at(i + 1) for i in range(30)]
                )
                splits = research_datasets.split_membership(
                    frame,
                    train_end=SESSIONS[validation_first - 1],
                    validation_end=SESSIONS[24],
                    cal=cal,
                    embargo_sessions=embargo,
                )
                train = splits[splits["split"] == "train"]
                reasons = train["purge_reason"].value_counts().to_dict()
                # A label purges when its end reaches the next split's first decision:
                # signals i >= first + 1 - H.
                self.assertEqual(
                    reasons.get("label_end_not_before_next_split", 0), purged
                )
                self.assertEqual(reasons.get("embargo", 0), embargoed)
                kept = train.loc[~train["purged"], "signal_session"]
                gap = max(horizon - 1, embargo)
                self.assertEqual(len(kept), max(validation_first - gap, 0))
                self.assertEqual(set(splits["split"]), {"train", "validation", "test"})
        with self.assertRaises(TypeError):
            research_datasets.split_membership(
                frame,
                train_end=SESSIONS[10],
                validation_end=SESSIONS[20],
                cal=cal,
                embargo_sessions=1.5,
            )


class NeutralizeTest(unittest.TestCase):
    def test_neutralized_labels_demean_within_group_excluding_benchmark(self) -> None:
        ids = [asset(20 + n) for n in range(13)]
        rows = benchmark_rows()
        for n, item in enumerate(ids):
            rows += session_rows(
                item, [100.0 + (n + 1) * i for i in range(len(SESSIONS))]
            )
        version = LabelVersion([*ids, BENCH], families={"daily_returns": rows})
        sectors = ["a"] * 6 + ["b"] * 5 + ["c"] * 2
        samples = pd.DataFrame(
            {
                "asset_id": [*ids, BENCH],
                "signal_session": [SESSIONS[3]] * 14,
                "sector": [*sectors, "a"],
            }
        )
        frame = research_datasets.forward_returns(
            version,
            samples,
            benchmark=BENCH,
            horizons=5,
            allow_static_universe=True,
            neutralize=["sector"],
        )
        excess = frame["forward_excess_return_5d"]
        neutral = frame["excess_return_5d_sector"]
        fallback = frame["neutral_fallback_5d_sector"]
        population = excess[:13]
        for group in ("a", "b"):
            members = [n for n, name in enumerate(sectors) if name == group]
            mean = population.iloc[members].mean()
            np.testing.assert_allclose(
                neutral.iloc[members], excess.iloc[members] - mean
            )
            self.assertFalse(fallback.iloc[members].any())
        # Group c has two members: session-wide mean over the 13 non-benchmark rows.
        np.testing.assert_allclose(
            neutral.iloc[11:13], excess.iloc[11:13] - population.mean()
        )
        self.assertTrue(fallback.iloc[11:13].all())
        # The benchmark row is demeaned but never part of a group mean.
        self.assertAlmostEqual(
            neutral.iloc[13], excess.iloc[13] - population.iloc[:6].mean()
        )
        with self.assertRaisesRegex(ValueError, "size"):
            research_datasets.forward_returns(
                version,
                samples,
                benchmark=BENCH,
                horizons=5,
                allow_static_universe=True,
                neutralize=["size"],
            )


class FamilyLabelTest(unittest.TestCase):
    def test_panel_reads_membership_returns_and_exits_from_a_bundle(self) -> None:
        sessions = bundle.SESSIONS
        rows: list[dict[str, Any]] = []
        for item, base in (
            (bundle.ASSET_A, 100.0),
            (bundle.ASSET_G1, 150.0),
            (bundle.BENCH_SPY, 500.0),
        ):
            closes = [base + i * 1.25 for i in range(len(sessions))]
            last = 20 if item == bundle.ASSET_G1 else len(sessions)
            rows += session_rows(
                item,
                closes[:last],
                days=[date.fromisoformat(day) for day in sessions],
                status={4: "disputed"} if item == bundle.ASSET_A else None,
            )
        rows.append(
            {
                **terminal_row(bundle.ASSET_G1, 0, "cash", 1.5, 200.0),
                "date": sessions[20],
            }
        )
        membership = [
            {
                "rule_version": rule,
                "effective_month": month,
                "effective_from": f"{month}-01",
                "asset_id": item,
                "member": member,
                "warmup": False,
                "observation_sequence": 1,
            }
            for rule in ("pit-largecap-v1", "pit-liquid-v1")
            for month, item, member in (
                ("2026-01", bundle.ASSET_A, True),
                ("2026-01", bundle.ASSET_G1, True),
                ("2026-02", bundle.ASSET_A, rule == "pit-liquid-v1"),
                ("2026-02", bundle.ASSET_G1, True),
            )
        ]
        delistings = [
            {
                "asset_id": bundle.ASSET_G1,
                "exit_type": "cash_merger",
                "successor_asset_id": "",
                "observation_sequence": 1,
                "observed_at": f"{sessions[21]}T00:00:00Z",
            }
        ]
        objects, _ = bundle._build_synthetic_bundle(
            extra_families={
                "universe_membership": membership,
                "daily_returns": rows,
                "delistings": delistings,
            }
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
            window = {"start": sessions[2], "end": sessions[24]}
            frame = ds.panel(
                ["AAPL", "GOOG"],
                time_policy="public_reconstructed",
                horizons=(1, 5),
                **window,
            )
            # January signals keep both; from the last January signal AAPL is out.
            aapl = frame[frame["asset_id"] == bundle.ASSET_A]
            self.assertEqual(
                str(aapl["signal_session"].max()), "2026-01-29"
            )  # entry 01-30 is the last January session
            self.assertTrue(frame["in_universe"].all())
            self.assertEqual(set(frame["h5_return_basis"]), {"total_return"})
            goog = frame[frame["asset_id"] == bundle.ASSET_G1].set_index(
                "signal_session"
            )
            exit_signal = date.fromisoformat(sessions[17])
            self.assertTrue(goog.loc[exit_signal, "h5_delisted_in_window"])
            self.assertEqual(goog.loc[exit_signal, "h5_post_exit_basis"], "cash")
            self.assertTrue(
                frame.loc[frame["asset_id"] == bundle.ASSET_A, "trainable_1d"].any()
            )
            disputed = frame[
                (frame["asset_id"] == bundle.ASSET_A)
                & (frame["signal_session"] == date.fromisoformat(sessions[2]))
            ]
            self.assertEqual(disputed["h5_disputed_sessions"].tolist(), [1])
            self.assertFalse(disputed["trainable_5d"].iloc[0])
            provenance = frame.attrs["provenance"]
            self.assertEqual(provenance["parameters"]["universe_basis"], "pit")
            self.assertEqual(provenance["parameters"]["return_basis"], "total_return")
            self.assertEqual(provenance["counts"]["not_in_universe_dropped"], 5)
            self.assertEqual(provenance["label_overlap"], {"1": 1.0, "5": 5.0})
            liquid = ds.forward_returns(
                ["AAPL"], universe="pit-liquid-v1", horizons=1, **window
            )
            self.assertEqual(len(liquid), 23)
            static = ds.forward_returns(
                ["AAPL"], universe="static", allow_static_universe=True, **window
            )
            self.assertTrue(static["in_universe"].isna().all())
            with self.assertRaisesRegex(ValueError, "UNIVERSE_NOT_PIT"):
                ds.forward_returns(["AAPL"], universe="static", **window)
            selection = {
                "dataset_id": bundle.DATASET_ID,
                "asset_ids": [bundle.ASSET_A, bundle.ASSET_G1],
                "benchmark_id": bundle.BENCH_SPY,
                "time_policy": "public_reconstructed",
                **window,
            }
            features, labels, splits, run = research_datasets.prepare(
                ds,
                horizon=1,
                train_end=sessions[10],
                validation_end=sessions[16],
                embargo_sessions=2,
                **selection,
            )
            self.assertEqual(len(features), len(labels))
            self.assertEqual(run["counts"]["not_in_universe_dropped"], 5)
            self.assertEqual(run["parameters"]["universe_basis"], "pit")
            self.assertEqual(set(labels["return_basis"]), {"total_return"})
            self.assertTrue(labels["trainable_1d"].any())
            embargoed = splits[splits["purge_reason"] == "embargo"]
            # H=1 labels end before the next split; the embargo drops two sessions.
            self.assertEqual(
                sorted({str(day) for day in embargoed["signal_session"]}),
                [sessions[9], sessions[10], sessions[15], sessions[16]],
            )
            weekly, _, _, run = research_datasets.prepare(
                ds, horizon=5, sampling="weekly", **selection
            )
            self.assertEqual(
                {day.weekday() for day in weekly["signal_session"]}, {4}
            )  # Fridays: no holidays in the synthetic calendar
            self.assertEqual(run["label_overlap"], {"5": 1.0})
            self.assertEqual(
                set(run["masks"]),
                {
                    "horizon_beyond_material",
                    "entry_price_missing",
                    "exit_price_missing",
                    "benchmark_missing",
                    "disputed_return",
                    "terminal_unknown",
                    "not_in_universe",
                    "return_unreliable",
                },
            )


if __name__ == "__main__":
    unittest.main()
