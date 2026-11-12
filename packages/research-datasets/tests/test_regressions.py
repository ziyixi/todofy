from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

import research_datasets
from research_datasets import asof, provenance
from tests import test_sdk as fixture


class PanelRegressionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.objects, _ = fixture._build_synthetic_bundle()

    def test_combiners_keep_filtered_reversed_and_duplicate_index_rows(self) -> None:
        with (
            fixture.SyntheticDatasetServer(self.objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = research_datasets.load(
                fixture.DATASET_ID,
                key=fixture.TOKEN,
                base_url=server.base_url,
                cache_dir=tmp,
            )
            candidates = ds.candidates(
                ["AAPL", "GOOG"], start=ds.calendar[6], end=ds.calendar[12]
            )
            selected = candidates.iloc[[2, 4, 8]]
            variants = (
                selected,
                selected.iloc[::-1],
                selected.set_axis([7, 7, 7]),
            )
            # A frozen recipe can predate the panel APIs. The installed package owns them.
            with mock.patch.object(ds, "recipe_source", side_effect=AssertionError):
                for samples in variants:
                    expected_keys = samples[research_datasets.KEYS].reset_index(
                        drop=True
                    )
                    with self.subTest(index=samples.index.tolist()):
                        labels = ds.forward_returns(
                            samples, horizons=(1, 5), allow_static_universe=True
                        )
                        pd.testing.assert_frame_equal(
                            labels[research_datasets.KEYS], expected_keys
                        )
                        for row in labels.itertuples(index=False):
                            day_index = ds.calendar.index(str(row.signal_session))
                            base = 100.0 if row.asset_id == fixture.ASSET_A else 150.0
                            for horizon in (1, 5):
                                asset_return = (base + (day_index + horizon) * 1.25) / (
                                    base + (day_index + 1) * 1.25 - 0.5
                                ) - 1
                                benchmark_return = (
                                    500.0 + (day_index + horizon) * 1.25
                                ) / (500.0 + (day_index + 1) * 1.25 - 0.5) - 1
                                self.assertAlmostEqual(
                                    getattr(row, f"forward_excess_return_{horizon}d"),
                                    asset_return - benchmark_return,
                                    places=12,
                                )
                        for builder in (ds.fundamental_features, ds.fundamental_ratios):
                            frame = builder(
                                samples,
                                period_kind=("quarter", "annual"),
                                time_policy="public_reconstructed",
                            )
                            pd.testing.assert_frame_equal(
                                frame[research_datasets.KEYS], expected_keys
                            )

    def test_candidates_use_winter_and_summer_new_york_offsets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            client = research_datasets.connect(
                fixture.TOKEN,
                base_url="https://dataset.example.test/read/v1",
                cache_dir=tmp,
            )
            ds = research_datasets.Dataset(
                client,
                {
                    "dataset_id": fixture.DATASET_ID,
                    "universe": [{"asset_id": fixture.ASSET_A, "symbol": "AAA"}],
                    "calendar": [
                        "2026-01-05",
                        "2026-01-06",
                        "2026-07-01",
                        "2026-07-02",
                    ],
                },
            )
            winter = ds.candidates("AAA", start="2026-01-05", end="2026-01-05")
            summer = ds.candidates("AAA", start="2026-07-01", end="2026-07-01")
            # 06:00 New York on the entry session, in winter and summer time.
            self.assertEqual(
                winter.iloc[0]["decision_at"], pd.Timestamp("2026-01-06T11:00:00Z")
            )
            self.assertEqual(
                winter.iloc[0]["previous_decision_at"],
                pd.Timestamp("2026-01-05T11:00:00Z"),
            )
            self.assertEqual(
                summer.iloc[0]["decision_at"], pd.Timestamp("2026-07-02T10:00:00Z")
            )

    def test_fact_revisions_are_available_at_or_before_decision(self) -> None:
        clocks = [
            "2026-07-02T12:59:59Z",
            "2026-07-02T13:00:00Z",
            "2026-07-02T13:00:01Z",
        ]
        facts = pd.DataFrame(
            [
                {
                    "fact_id": "synthetic-revenue",
                    "cik": fixture.CIK_A,
                    "metric": "revenue",
                    "unit": "USD",
                    "period_kind": "quarter",
                    "period_end": "2026-06-30",
                    "public_at": clock,
                    "public_time_precision": "second",
                    "observed_at": clock,
                    "observation_sequence": index + 1,
                    "is_retracted": False,
                    "value": str((index + 1) * 100),
                }
                for index, clock in enumerate(clocks)
            ]
        )
        samples = pd.DataFrame(
            {
                "asset_id": [fixture.ASSET_A] * 3,
                "signal_session": ["2026-07-01"] * 3,
                "decision_at": clocks,
            }
        )
        material = {
            "manifest": {},
            "universe": [
                {
                    "asset_id": fixture.ASSET_A,
                    "cik": fixture.CIK_A,
                    "issuer_mapping_status": "verified",
                }
            ],
            "fundamentals": facts,
        }
        for policy in ("observed_content", "public_reconstructed"):
            with self.subTest(policy=policy):
                result = research_datasets.prepare_fundamental_features(
                    material,
                    samples,
                    metrics={"revenue": "USD"},
                    time_policy=policy,
                )
                self.assertEqual(
                    result["revenue_value"].tolist(), [100.0, 200.0, 300.0]
                )


def _load(server: fixture.SyntheticDatasetServer, cache_dir: str, **kwargs):
    return research_datasets.load(
        fixture.DATASET_ID,
        key=fixture.TOKEN,
        base_url=server.base_url,
        cache_dir=cache_dir,
        **kwargs,
    )


class ContractRegressionTest(unittest.TestCase):
    def test_time_policy_is_required(self) -> None:
        objects, _ = fixture._build_synthetic_bundle()
        with (
            fixture.SyntheticDatasetServer(objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = _load(server, tmp)
            window = {"start": ds.calendar[6], "end": ds.calendar[8]}
            selection = {
                "dataset_id": fixture.DATASET_ID,
                "asset_ids": [fixture.ASSET_A],
                "benchmark_id": fixture.BENCH_SPY,
                **window,
            }
            calls = {
                "panel": lambda: research_datasets.panel(ds, ["AAPL"], **window),
                "daily_features": lambda: research_datasets.daily_features(
                    ds, ["AAPL"], **window
                ),
                "prepare": lambda: research_datasets.prepare(ds, **selection),
                "fundamental_features": lambda: research_datasets.fundamental_features(
                    ds, ["AAPL"], **window
                ),
                "fundamental_ratios": lambda: research_datasets.fundamental_ratios(
                    ds, ["AAPL"], **window
                ),
                "Dataset.panel": lambda: ds.panel(["AAPL"], **window),
                "Dataset.daily_features": lambda: ds.daily_features(["AAPL"], **window),
                "Dataset.prepare": lambda: ds.prepare(**selection),
                "Dataset.fundamental_features": lambda: ds.fundamental_features(
                    ["AAPL"], **window
                ),
                "extra_features": lambda: research_datasets.extra_features(
                    ds, ds.candidates(["AAPL"], universe="static", **window)
                ),
                "Dataset.extra_features": lambda: ds.extra_features(["AAPL"], **window),
            }
            before = server.request_count
            for name, call in calls.items():
                with self.subTest(name), self.assertRaises(TypeError):
                    call()
            self.assertEqual(server.request_count, before)
            with self.assertRaisesRegex(ValueError, "time policy"):
                ds.daily_features(["AAPL"], time_policy="hybrid", **window)

    def test_stale_quarter_cash_flow_columns_not_in_defaults(self) -> None:
        objects, _ = fixture._build_synthetic_bundle()
        with (
            fixture.SyntheticDatasetServer(objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = _load(server, tmp)
            derived_frame = ds.panel(
                ["AAPL", "GOOG"],
                start=ds.calendar[6],
                end=ds.calendar[8],
                time_policy="public_reconstructed",
                allow_static_universe=True,
            )
            for name in (
                "operating_cash_flow_q_value",
                "fcf_q_value",
                "revenue_q_value",
                "gross_margin_ttm_value",
            ):
                self.assertIn(name, derived_frame.columns)
            frame = ds.panel(
                ["AAPL", "GOOG"],
                start=ds.calendar[6],
                end=ds.calendar[8],
                time_policy="public_reconstructed",
                fundamentals="legacy",
                allow_static_universe=True,
            )
            for prefix in (
                "quarter_operating_cash_flow_",
                "quarter_capex_",
                "quarter_free_cash_flow",
                "quarter_source_operating_cash_flow_",
                "quarter_source_capex_",
            ):
                with self.subTest(prefix=prefix):
                    self.assertEqual(
                        [name for name in frame if name.startswith(prefix)], []
                    )
            for name in (
                "quarter_revenue_value",
                "quarter_gross_margin_value",
                "annual_operating_cash_flow_value",
                "annual_capex_value",
                "annual_free_cash_flow_value",
            ):
                self.assertIn(name, frame.columns)
            explicit = ds.fundamental_features(
                frame[[*research_datasets.KEYS, "decision_at"]],
                metrics=["operating_cash_flow"],
                time_policy="public_reconstructed",
            )
            self.assertIn("operating_cash_flow_value", explicit.columns)

    def test_panel_fundamentals_are_lean_unless_provenance_columns(self) -> None:
        objects, _ = fixture._build_synthetic_bundle()
        with (
            fixture.SyntheticDatasetServer(objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = _load(server, tmp)
            options = {
                "start": ds.calendar[6],
                "end": ds.calendar[8],
                "time_policy": "public_reconstructed",
                "allow_static_universe": True,
            }
            derived_lean = ds.panel(["AAPL", "GOOG"], **options)
            derived_full = ds.panel(
                ["AAPL", "GOOG"], provenance_columns=True, **options
            )
            lean = ds.panel(["AAPL", "GOOG"], fundamentals="legacy", **options)
            full = ds.panel(
                ["AAPL", "GOOG"],
                fundamentals="legacy",
                provenance_columns=True,
                **options,
            )
        self.assertIn("ok", set(derived_lean["revenue_q_status"]))
        self.assertNotIn("revenue_q_available_at", derived_lean.columns)
        self.assertIn("revenue_q_available_at", derived_full.columns)
        self.assertEqual(
            [name for name in derived_full if name in derived_lean],
            list(derived_lean.columns),
        )
        for name in ("quarter_revenue_status", "quarter_gross_margin_status"):
            self.assertIsInstance(lean[name].dtype, pd.CategoricalDtype)
            self.assertEqual(lean[name].astype(object).tolist(), full[name].tolist())
        self.assertIn("ok", set(lean["quarter_revenue_status"]))
        pd.testing.assert_series_equal(
            lean["quarter_revenue_value"], full["quarter_revenue_value"]
        )
        for name in (
            "quarter_revenue_fact_id",
            "quarter_revenue_available_at",
            "quarter_source_revenue_fact_id",
            "annual_prior_revenue_period_end",
        ):
            self.assertNotIn(name, lean.columns)
            self.assertIn(name, full.columns)
        # Only fundamental columns differ; the lean columns keep the full panel's order.
        extra = [name for name in full if name not in lean]
        self.assertTrue(
            extra
            and all(
                name.startswith(("quarter_", "annual_", "instant_")) for name in extra
            )
        )
        self.assertEqual([name for name in full if name in lean], list(lean.columns))
        self.assertFalse(lean.attrs["provenance"]["parameters"]["provenance_columns"])

    def test_manifest_schema_newer_than_client_is_refused(self) -> None:
        newest = research_datasets.MANIFEST_SCHEMA_MAX
        objects, _ = fixture._build_synthetic_bundle(
            manifest_updates={"schema_version": newest + 1}
        )
        with (
            fixture.SyntheticDatasetServer(objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            with self.assertRaises(research_datasets.DatasetError) as caught:
                _load(server, tmp)
            self.assertEqual(caught.exception.reason, "CLIENT_TOO_OLD")
            self.assertIn("重新安装 SDK", str(caught.exception))
        objects, _ = fixture._build_synthetic_bundle(
            manifest_updates={"schema_version": newest}
        )
        with (
            fixture.SyntheticDatasetServer(objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            self.assertEqual(_load(server, tmp).id, fixture.DATASET_ID)

    def test_client_min_version_is_enforced(self) -> None:
        for minimum, accepted in (
            ("1.0.0", True),
            ("2.0.0rc1", True),
            ("2.0.0b9", True),
            ("2.0.0", True),
            ("2.0.1", True),
            ("2.1.0rc1", True),
            ("2.1.0", True),
            ("2.1.1", True),
            ("2.2.0rc1", True),
            ("2.2.0", True),
            ("2.2.1", True),
            ("2.3.0rc1", True),
            ("2.3.0", True),
            ("2.3.1", False),
            ("2.3.1rc1", False),
            ("2.4.0", False),
            ("next", False),
        ):
            manifest = {"schema_version": 2, "client_min_version": minimum}
            with self.subTest(minimum=minimum):
                if accepted:
                    research_datasets.check_manifest(manifest)
                    continue
                with self.assertRaises(research_datasets.DatasetError) as caught:
                    research_datasets.check_manifest(manifest)
                self.assertEqual(caught.exception.reason, "CLIENT_TOO_OLD")
        with self.assertRaises(research_datasets.DatasetError) as caught:
            research_datasets.check_manifest({"schema_version": "3"})
        self.assertEqual(caught.exception.reason, "INTEGRITY")

    def test_unknown_family_schema_refused_on_read_only(self) -> None:
        objects, _ = fixture._build_synthetic_bundle(
            family_updates={"news_versions": {"schema_version": 2}}
        )
        with (
            fixture.SyntheticDatasetServer(objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = _load(server, tmp, preload=True)
            self.assertFalse(ds.prices("AAPL").empty)
            self.assertEqual(len(ds.family("symbol_history")), 4)
            with self.assertRaises(research_datasets.DatasetError) as caught:
                ds.family("news_versions")
            self.assertEqual(caught.exception.reason, "CLIENT_TOO_OLD")

    def test_new_registered_family_reads_without_keyerror(self) -> None:
        objects, _ = fixture._build_synthetic_bundle(
            extra_families={"future_family": [{"asset_id": fixture.ASSET_A, "x": 1}]}
        )
        with (
            fixture.SyntheticDatasetServer(objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = _load(server, tmp, preload=True)
            news = ds.family("news_versions", columns=["event_id", "story_key"])
            self.assertEqual(news.columns.tolist(), ["event_id", "story_key"])
            self.assertEqual(sorted(news["event_id"]), ["news-1", "news-2"])
            history = ds.family("symbol_history", ["GOOG"])
            self.assertEqual(history["symbol"].tolist(), ["GOOG"])
            self.assertEqual(
                len(ds.family("event_observations", ["GOOG"], columns=["event_uid"])),
                1,
            )
            for name, symbols, reason in (
                ("future_family", None, "CLIENT_TOO_OLD"),
                ("not_frozen", None, "CAPABILITY_MISSING"),
                ("news_versions", ["AAPL"], "BAD_REQUEST"),
                ("raw", None, "BAD_REQUEST"),
            ):
                with (
                    self.subTest(name=name),
                    self.assertRaises(research_datasets.DatasetError) as caught,
                ):
                    ds.family(name, symbols)
                self.assertEqual(caught.exception.reason, reason)
            self.assertFalse(ds.events("AAPL").empty)

    def test_family_reader_filters_list_linked_families_by_security(self) -> None:
        linked = [
            {"event_uid": "a", "asset_ids": [fixture.ASSET_A]},
            {"event_uid": "g", "asset_ids": [fixture.ASSET_G1, fixture.ASSET_G2]},
        ]
        objects, _ = fixture._build_synthetic_bundle(
            extra_families={"linked_family": linked}
        )
        spec = research_datasets.FamilySpec("asset_id", None, frozenset({1}))
        with (
            fixture.SyntheticDatasetServer(objects) as server,
            tempfile.TemporaryDirectory() as tmp,
            mock.patch.dict(research_datasets.FAMILY_SPECS, linked_family=spec),
        ):
            ds = _load(server, tmp)
            day = ds.calendar[10]
            # events keeps its list links and event_date fallback when columns are given.
            events = ds.family("events", ["AAPL"], columns=["event_uid"])
            self.assertEqual(events.columns.tolist(), ["event_uid"])
            self.assertEqual(events["event_uid"].tolist(), ["evt-sec-1"])
            self.assertEqual(
                len(ds.family("events", ["AAPL"], day, day, columns=["event_uid"])), 1
            )
            for symbols, start in ((["GOOG"], None), (["AAPL"], ds.calendar[11])):
                with self.subTest(symbols=symbols, start=start):
                    self.assertTrue(
                        ds.family("events", symbols, start, columns=["event_uid"]).empty
                    )
            with self.assertRaises(research_datasets.DatasetError) as caught:
                ds.family("events", ["AAPL"], columns=["nope"])
            self.assertEqual(caught.exception.reason, "BAD_REQUEST")
            # A registered family linking securities through asset_ids filters the same way.
            for symbols, expected in ((["GOOGL"], ["g"]), (["AAPL"], ["a"])):
                with self.subTest(symbols=symbols):
                    frame = ds.family("linked_family", symbols, columns=["event_uid"])
                    self.assertEqual(frame["event_uid"].tolist(), expected)


class ProvenanceAndAsofTest(unittest.TestCase):
    def test_code_digest_changes_when_constants_change(self) -> None:
        package = provenance.PACKAGE_DIRECTORY
        with tempfile.TemporaryDirectory() as tmp:
            copy = Path(tmp) / "research_datasets"
            shutil.copytree(package, copy)
            before = research_datasets.code_digest(copy)
            self.assertEqual(before, research_datasets.code_digest())
            (copy / "py.typed").write_text("not a module\n")
            self.assertEqual(research_datasets.code_digest(copy), before)
            constants = copy / "constants.py"
            constants.write_text(constants.read_text() + "\nEXTRA = 1\n")
            self.assertNotEqual(research_datasets.code_digest(copy), before)
        record = provenance.run_record(
            dataset_id="d",
            manifest_sha256="0" * 64,
            parameters={},
            counts={},
            limitations=[],
        )
        self.assertEqual(record["code_sha256"], research_datasets.code_digest())
        self.assertEqual(record["package_version"], research_datasets.__version__)

    def test_evaluation_only_family_refused_by_asof_join(self) -> None:
        samples = pd.DataFrame(
            {
                "asset_id": ["a", "b", "a", "a"],
                "decision_at": [
                    "2026-03-09T10:00:00Z",
                    "2026-03-09T10:00:00Z",
                    "2026-03-06T11:00:00Z",
                    None,
                ],
            },
            index=[7, 7, 3, 1],
        )
        table = pd.DataFrame(
            {
                "asset_id": ["a", "a", "a", "b"],
                "available_at": [
                    "2026-03-06T11:00:00Z",
                    "2026-03-09T10:00:00Z",
                    None,
                    "2026-03-09T10:00:01Z",
                ],
                "value": [1.0, 2.0, 3.0, 4.0],
            }
        )
        joined = research_datasets.asof_join(
            samples, table, by="asset_id", columns=["value"]
        )
        # Inclusive at the decision instant, in sample order, keeping the index.
        self.assertEqual(joined.index.tolist(), [7, 7, 3, 1])
        np.testing.assert_array_equal(joined["value"], [2.0, np.nan, 1.0, np.nan])
        self.assertEqual(joined.attrs["unclocked_rows"], 1)
        strict = research_datasets.asof_join(
            samples, table, by="asset_id", columns=["value"], inclusive=False
        )
        np.testing.assert_array_equal(strict["value"], [1.0, np.nan, np.nan, np.nan])
        # Categorical keys match plain or categorical keys on the other side.
        categorical = samples.assign(asset_id=pd.Categorical(samples["asset_id"]))
        for right in (table, table.assign(asset_id=pd.Categorical(table["asset_id"]))):
            with self.subTest(right=str(right["asset_id"].dtype)):
                keyed = research_datasets.asof_join(
                    categorical, right, by="asset_id", columns=["value"]
                )
                np.testing.assert_array_equal(keyed["value"], joined["value"])
        # Clocks without an offset are not instants: such rows and samples are unclocked.
        decisions = ["2026-03-09T10:00:00", *samples["decision_at"].tolist()[1:]]
        clocks = ["2026-03-06T11:00:00", *table["available_at"].tolist()[1:]]
        naive = research_datasets.asof_join(
            samples.assign(decision_at=decisions),
            table.assign(available_at=clocks),
            by="asset_id",
            columns=["value"],
        )
        np.testing.assert_array_equal(naive["value"], [np.nan, np.nan, np.nan, np.nan])
        self.assertEqual(naive.attrs["unclocked_rows"], 2)
        spec = research_datasets.FamilySpec("none", None, frozenset({1}), True)
        with mock.patch.dict(research_datasets.FAMILY_SPECS, {"factor_returns": spec}):
            with self.assertRaisesRegex(ValueError, "EVALUATION_ONLY"):
                research_datasets.asof_join(
                    samples,
                    table,
                    by="asset_id",
                    columns=["value"],
                    family="factor_returns",
                )
            table.attrs["family"] = "factor_returns"
            with self.assertRaisesRegex(ValueError, "EVALUATION_ONLY"):
                research_datasets.asof_join(
                    samples, table, by="asset_id", columns=["value"]
                )
        changes = pd.DataFrame(
            {
                "group": ["a", "a", "a", "a", "b"],
                "time": [1, 2, 2, 3, 1],
                "state": [1.0, 5.0, 2.0, 2.0, np.nan],
            }
        )
        stream = asof.step_stream(changes, by="group", time="time", state=["state"])
        self.assertEqual(stream["time"].tolist(), [1, 1, 2])
        self.assertEqual(stream["group"].tolist(), ["a", "b", "a"])


class TransportRegressionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.objects, _ = fixture._build_synthetic_bundle()

    def test_redirect_is_refused_without_contacting_target(self) -> None:
        with (
            fixture.SyntheticDatasetServer(self.objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            client = research_datasets.connect(
                fixture.TOKEN, base_url=server.base_url + "/", cache_dir=tmp
            )
            with self.assertRaises(research_datasets.DatasetError) as caught:
                client._request("redirect")
            self.assertEqual(caught.exception.reason, "REDIRECT_REFUSED")
            self.assertEqual(server.request_paths, ["/read/v1/redirect"])

    def test_session_budget_refuses_an_extra_artifact_request(self) -> None:
        with (
            fixture.SyntheticDatasetServer(self.objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = research_datasets.load(
                fixture.DATASET_ID,
                key=fixture.TOKEN,
                base_url=server.base_url,
                cache_dir=tmp,
                max_requests=1,
            )
            with self.assertRaises(research_datasets.DatasetError) as caught:
                ds.prices("AAPL")
            self.assertEqual(caught.exception.reason, "SESSION_BUDGET")
            self.assertEqual(server.request_count, 1)

    def test_new_session_replaces_a_corrupt_cached_part(self) -> None:
        with (
            fixture.SyntheticDatasetServer(self.objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            args = {"key": fixture.TOKEN, "base_url": server.base_url, "cache_dir": tmp}
            ds = research_datasets.load(fixture.DATASET_ID, **args)
            expected = ds.prices("AAPL")
            item = ds._parts("all")[0]
            path = Path(tmp) / f"{item['sha256']}.parquet"
            contents = path.read_bytes()
            path.write_bytes(bytes([contents[0] ^ 0xFF]) + contents[1:])
            before = server.request_count
            restored = research_datasets.load(fixture.DATASET_ID, **args).prices("AAPL")
            pd.testing.assert_frame_equal(restored, expected)
            self.assertEqual(server.request_count - before, 2)

    def test_returned_family_objects_and_attrs_cannot_mutate_cached_data(self) -> None:
        with (
            fixture.SyntheticDatasetServer(self.objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = research_datasets.load(
                fixture.DATASET_ID,
                key=fixture.TOKEN,
                base_url=server.base_url,
                cache_dir=tmp,
            )
            observations = ds.event_observations()
            original_clock = dict(observations.at[0, "asset_first_seen_at"])[
                fixture.ASSET_A
            ]
            observations.at[0, "asset_first_seen_at"][0] = (
                fixture.ASSET_A,
                "1900-01-01T00:00:00Z",
            )
            observations.at[0, "asset_ids"][0] = fixture.ASSET_G1
            facts = ds.fundamentals(["AAPL", "SPY"])
            facts.attrs["unmapped_asset_ids"].clear()
            prices = ds.prices("AAPL")
            original_close = prices.at[0, "close"]
            original_dtypes = prices.dtypes
            prices.at[0, "close"] = -1.0
            requests = server.request_count

            with mock.patch(
                "research_datasets.client.pads.dataset", side_effect=AssertionError
            ):
                for _ in range(2):
                    fresh = ds.event_observations()
                    self.assertEqual(
                        dict(fresh.at[0, "asset_first_seen_at"])[fixture.ASSET_A],
                        original_clock,
                    )
                    self.assertEqual(
                        fresh.at[0, "asset_ids"].tolist(), [fixture.ASSET_A]
                    )
                    fresh.at[0, "asset_first_seen_at"][0] = (fixture.ASSET_A, "x")
                    fresh_facts = ds.fundamentals(["AAPL", "SPY"])
                    self.assertEqual(
                        fresh_facts.attrs["unmapped_asset_ids"], [fixture.BENCH_SPY]
                    )
                    fresh_facts.attrs["unmapped_asset_ids"].clear()
                    fresh_prices = ds.prices("AAPL")
                    self.assertEqual(fresh_prices.at[0, "close"], original_close)
                    pd.testing.assert_series_equal(fresh_prices.dtypes, original_dtypes)
            self.assertEqual(server.request_count, requests)

    def test_invalid_endpoint_or_missing_key_is_rejected_before_requests(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            for base_url in (
                "http://dataset.example.test/read/v1",
                "https://user:password@dataset.example.test/read/v1",
                "https://dataset.example.test/read/v1?key=value",
                "https://dataset.example.test/read/v1#fragment",
            ):
                with (
                    self.subTest(base_url=base_url),
                    self.assertRaises(research_datasets.DatasetError) as caught,
                ):
                    research_datasets.connect(
                        fixture.TOKEN, base_url=base_url, cache_dir=tmp
                    )
                self.assertEqual(caught.exception.reason, "BASE_URL_INVALID")
            with self.assertRaises(TypeError):
                research_datasets.connect(
                    base_url="https://dataset.example.test/read/v1"
                )


if __name__ == "__main__":
    unittest.main()
