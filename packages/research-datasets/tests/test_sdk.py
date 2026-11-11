from __future__ import annotations

import hashlib
import io
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Self
from urllib.parse import parse_qs, urlsplit

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

import research_datasets

DATASET_ID = "00000000-0000-4000-8000-000000000001"
ASSET_A = "00000000-0000-4000-8000-000000000011"
ASSET_G1 = "00000000-0000-4000-8000-000000000012"
ASSET_G2 = "00000000-0000-4000-8000-000000000013"
BENCH_SPY = "00000000-0000-4000-8000-000000000099"
CIK_A = "0000000101"
CIK_G = "0000000102"
TOKEN = "synthetic.bearer+key/with=padding"
LIMITATION_PREFIX = "A row is decided at 06:00 New York"


STORY = "synthetic-story-key-0001"
SESSIONS = pd.bdate_range("2026-01-02", periods=32).strftime("%Y-%m-%d").tolist()
OBSERVATION_SCHEMA = pa.schema(
    [
        ("observation_id", pa.string()),
        ("event_id", pa.string()),
        ("event_uid", pa.string()),
        ("source", pa.string()),
        ("form", pa.string()),
        ("filing_date", pa.string()),
        ("event_date", pa.string()),
        ("asset_ids", pa.list_(pa.string())),
        ("asset_first_seen_at", pa.map_(pa.string(), pa.string())),
        ("content_first_seen_at", pa.string()),
        ("observation_recorded_at", pa.string()),
        ("observation_sequence", pa.int64()),
        ("public_time_precision", pa.string()),
        ("public_at", pa.string()),
        ("public_date", pa.string()),
    ]
)


def _parquet_bytes(
    rows: list[dict[str, object]], schema: pa.Schema | None = None
) -> bytes:
    table = pa.Table.from_pylist(rows, schema=schema)
    buf = io.BytesIO()
    pq.write_table(table, buf)
    return buf.getvalue()


def observation(
    uid: str, source: str, assets: list[str], public_at: str, **changes: object
) -> dict[str, object]:
    """One frozen event observation version, captured when it became public."""
    values: dict[str, object] = {
        "observation_id": f"obs-{uid}-{changes.get('observation_sequence', 1)}",
        "event_id": uid,
        "event_uid": uid,
        "source": source,
        "form": "8-K" if source == "sec" else None,
        "filing_date": public_at[:10] if source == "sec" else None,
        "event_date": public_at[:10],
        "asset_ids": assets,
        "asset_first_seen_at": {asset: public_at for asset in assets},
        "content_first_seen_at": public_at,
        "observation_recorded_at": public_at,
        "observation_sequence": 1,
        "public_time_precision": "second",
        "public_at": public_at,
        "public_date": "",
    }
    values.update(changes)
    return values


def default_observations() -> list[dict[str, object]]:
    """A legacy-form SEC filing, two articles of one story and an unknown source."""
    return [
        observation("evt-sec-1", "sec", [ASSET_A], f"{SESSIONS[5]}T20:00:00Z"),
        observation(
            "news-1", "alpaca_news", [ASSET_A, ASSET_G1], f"{SESSIONS[7]}T15:00:00Z"
        ),
        observation("news-2", "alpaca_news", [ASSET_A], f"{SESSIONS[7]}T18:00:00Z"),
        observation("future-1", "future_x", [ASSET_A], f"{SESSIONS[7]}T18:00:00Z"),
    ]


def _build_synthetic_bundle(
    financial_status: str = "checked",
    *,
    observations: list[dict[str, object]] | None = None,
    extra_families: dict[str, list[dict[str, object]]] | None = None,
    family_updates: dict[str, dict[str, object]] | None = None,
    manifest_updates: dict[str, object] | None = None,
) -> tuple[dict[str, bytes], str]:
    sessions = SESSIONS
    recipe_bytes = b"# synthetic recipe\n__version__ = '1.0.0'\n"

    universe = [
        {
            "asset_id": ASSET_A,
            "symbol": "AAPL",
            "exchange": "XNAS",
            "status": "active",
            "cik": CIK_A,
            "issuer_mapping_status": "verified",
        },
        {
            "asset_id": ASSET_G1,
            "symbol": "GOOG",
            "exchange": "XNAS",
            "status": "active",
            "cik": CIK_G,
            "issuer_mapping_status": "verified",
        },
        {
            "asset_id": ASSET_G2,
            "symbol": "GOOGL",
            "exchange": "XNAS",
            "status": "active",
            "cik": CIK_G,
            "issuer_mapping_status": "verified",
        },
        {
            "asset_id": BENCH_SPY,
            "symbol": "SPY",
            "exchange": "ARCX",
            "status": "active",
            "cik": None,
            "issuer_mapping_status": "not_applicable",
        },
    ]

    raw_rows: list[dict[str, object]] = []
    all_rows: list[dict[str, object]] = []
    for idx, session in enumerate(sessions):
        for asset_id, symbol, base_price in [
            (ASSET_A, "AAPL", 100.0),
            (ASSET_G1, "GOOG", 150.0),
            (ASSET_G2, "GOOGL", 149.0),
            (BENCH_SPY, "SPY", 500.0),
        ]:
            close = base_price + idx * 1.25
            for adjustment, factor, target in [
                ("raw", 1.0, raw_rows),
                ("all", 0.99, all_rows),
            ]:
                target.append(
                    {
                        "asset_id": asset_id,
                        "symbol": symbol,
                        "adjustment": adjustment,
                        "date": session,
                        "open": round((close - 0.5) * factor, 4),
                        "high": round((close + 1.0) * factor, 4),
                        "low": round((close - 1.0) * factor, 4),
                        "close": round(close * factor, 4),
                        "volume": 1_000_000.0 + idx * 10_000.0,
                        "vwap": round(close * factor, 4),
                        "trade_count": 5000 + idx * 10,
                        "source_asof": sessions[-1],
                    }
                )

    raw_bytes = _parquet_bytes(raw_rows)
    all_bytes = _parquet_bytes(all_rows)

    coverage_bytes = _parquet_bytes(
        [
            {
                "asset_id": asset_id,
                "adjustment": adj,
                "first_date": sessions[0],
                "last_date": sessions[-1],
                "bar_count": len(sessions),
            }
            for asset_id in (ASSET_A, ASSET_G1, ASSET_G2, BENCH_SPY)
            for adj in ("raw", "all")
        ]
    )

    events_bytes = _parquet_bytes(
        [
            {
                "event_uid": "evt-sec-1",
                "asset_ids": [ASSET_A],
                "symbol": "AAPL",
                "source": "sec",
                "event_date": sessions[10],
                "filing_date": sessions[10],
                "available_session": sessions[11],
            }
        ]
    )

    event_obs_bytes = _parquet_bytes(
        default_observations() if observations is None else observations,
        OBSERVATION_SCHEMA,
    )

    source_checks_bytes = _parquet_bytes(
        [
            {
                "asset_id": asset_id,
                "source": source,
                "checked_start": sessions[0],
                "checked_end": sessions[-1],
                "checked_at": f"{sessions[0]}T00:00:00Z",
                "status": "partial" if source == "alpaca_news" else "checked",
                "error_code": "SOURCE_PUBLICATION_COVERAGE_UNKNOWN"
                if source == "alpaca_news"
                else "",
                "count": 1,
            }
            for asset_id in (ASSET_A, ASSET_G1, ASSET_G2, BENCH_SPY)
            for source in (
                "sec",
                "alpaca_news",
                "alpaca_actions",
                "finnhub_news",
                "finnhub_earnings",
            )
        ]
    )

    news_versions_bytes = _parquet_bytes(
        [
            {
                "version_id": f"version-{uid}",
                "event_id": uid,
                "source": "alpaca_news",
                "provider_updated_at": f"{sessions[7]}T{hour}:00:00Z",
                "story_key": STORY,
                "observed_at": f"{sessions[7]}T{hour}:00:00Z",
            }
            for uid, hour in (("news-1", 15), ("news-2", 18))
        ]
    )

    symbol_history_bytes = _parquet_bytes(
        [
            {
                "asset_id": asset_id,
                "version": 1,
                "ordinal": 0,
                "symbol": symbol,
                "valid_from": "2016-01-04",
                "valid_to": "",
                "status": "verified",
                "basis": "synthetic",
            }
            for asset_id, symbol in [
                (ASSET_A, "AAPL"),
                (ASSET_G1, "GOOG"),
                (ASSET_G2, "GOOGL"),
                (BENCH_SPY, "SPY"),
            ]
        ]
    )

    earnings_bytes = _parquet_bytes(
        [
            {
                "observation_id": "earn-1",
                "asset_id": ASSET_A,
                "symbol": "AAPL",
                "report_date": sessions[8],
                "observed_at": f"{sessions[8]}T21:06:00Z",
                "observation_sequence": 1,
            }
        ]
    )

    security_history_bytes = _parquet_bytes(
        [
            {
                "asset_id": asset_id,
                "symbol": symbol,
                "observed_at": f"{sessions[0]}T00:00:00Z",
            }
            for asset_id, symbol in [
                (ASSET_A, "AAPL"),
                (ASSET_G1, "GOOG"),
                (ASSET_G2, "GOOGL"),
                (BENCH_SPY, "SPY"),
            ]
        ]
    )

    fact_rows: list[dict[str, object]] = []
    obs_seq = 0
    for cik, rev_base in [(CIK_A, 1000.0), (CIK_G, 2000.0)]:
        periods = [
            (
                "2024-10-01",
                "2024-12-31",
                "2025-01-20T20:10:00Z",
                "quarter",
                "0001-25-000001",
            ),
            (
                "2025-10-01",
                "2025-12-31",
                "2026-01-05T20:10:00Z",
                "quarter",
                "0001-26-000001",
            ),
            (
                "2024-01-01",
                "2024-12-31",
                "2025-01-25T20:10:00Z",
                "annual",
                "0001-25-000002",
            ),
            (
                "2025-01-01",
                "2025-12-31",
                "2026-01-06T20:10:00Z",
                "annual",
                "0001-26-000002",
            ),
        ]
        for p_idx, (p_start, p_end, pub_at, pk, acc) in enumerate(periods):
            scale = rev_base + p_idx * 100.0
            duration_vals = {
                "revenue": (str(scale), "USD", "USD"),
                "gross_profit": (str(scale * 0.45), "USD", "USD"),
                "operating_income": (str(scale * 0.30), "USD", "USD"),
                "net_income": (str(scale * 0.22), "USD", "USD"),
                "operating_cash_flow": (str(scale * 0.28), "USD", "USD"),
                "capex": (str(scale * 0.06), "USD", "USD"),
                "diluted_eps": ("1.50", "USD/shares", "USD"),
                "weighted_average_shares_basic": ("1000", "shares", ""),
                "weighted_average_shares_diluted": ("1010", "shares", ""),
            }
            for metric, (val, unit, currency) in duration_vals.items():
                obs_seq += 1
                fact_rows.append(
                    {
                        "observation_id": f"obs-{obs_seq}",
                        "fact_id": f"fact-{cik}-{metric}-{pk}-{p_end}",
                        "cik": cik,
                        "metric": metric,
                        "period_kind": pk,
                        "period_start": p_start,
                        "period_end": p_end,
                        "unit": unit,
                        "currency": currency,
                        "accession": acc,
                        "tag": metric,
                        "tag_priority": 1,
                        "source_url": "https://sec.example.invalid/fact",
                        "public_at": pub_at,
                        "public_date": pub_at[:10],
                        "public_time_precision": "second",
                        "observed_at": pub_at,
                        "observation_sequence": 1,
                        "is_retracted": False,
                        "value": val,
                    }
                )
        for metric, (val, unit, currency) in {
            "cash": ("500.0", "USD", "USD"),
            "total_assets": ("4000.0", "USD", "USD"),
            "total_liabilities": ("1500.0", "USD", "USD"),
            "equity": ("2500.0", "USD", "USD"),
            "shares_outstanding": ("1000", "shares", ""),
        }.items():
            obs_seq += 1
            fact_rows.append(
                {
                    "observation_id": f"obs-{obs_seq}",
                    "fact_id": f"fact-{cik}-{metric}-inst",
                    "cik": cik,
                    "metric": metric,
                    "period_kind": "instant",
                    "period_start": None,
                    "period_end": "2025-12-31",
                    "unit": unit,
                    "currency": currency,
                    "accession": "0001-26-000001",
                    "tag": metric,
                    "tag_priority": 1,
                    "source_url": "https://sec.example.invalid/fact",
                    "public_at": "2026-01-05T20:10:00Z",
                    "public_date": "2026-01-05",
                    "public_time_precision": "second",
                    "observed_at": "2026-01-05T20:10:00Z",
                    "observation_sequence": 1,
                    "is_retracted": False,
                    "value": val,
                }
            )
    fundamentals_bytes = _parquet_bytes(fact_rows)

    financial_checks_bytes = _parquet_bytes(
        [
            {
                "check_id": f"chk-{cik}",
                "cik": cik,
                "check_sequence": 1,
                "status": financial_status,
                "error_code": "",
                "fetch_performed": financial_status == "checked",
                "initial": financial_status == "checked",
                "checked_at": "2026-01-01T12:00:00Z",
            }
            for cik in (CIK_A, CIK_G)
        ]
    )

    prefix = f"datasets/{DATASET_ID}"
    objects: dict[str, bytes] = {
        f"{prefix}/raw/part-0000.parquet": raw_bytes,
        f"{prefix}/all/part-0000.parquet": all_bytes,
        f"{prefix}/price_coverage/part-0000.parquet": coverage_bytes,
        f"{prefix}/events/part-0000.parquet": events_bytes,
        f"{prefix}/event_observations/part-0000.parquet": event_obs_bytes,
        f"{prefix}/source_checks/part-0000.parquet": source_checks_bytes,
        f"{prefix}/earnings_observations/part-0000.parquet": earnings_bytes,
        f"{prefix}/security_history/part-0000.parquet": security_history_bytes,
        f"{prefix}/fundamentals/part-0000.parquet": fundamentals_bytes,
        f"{prefix}/financial_checks/part-0000.parquet": financial_checks_bytes,
        f"{prefix}/news_versions/part-0000.parquet": news_versions_bytes,
        f"{prefix}/symbol_history/part-0000.parquet": symbol_history_bytes,
        f"{prefix}/recipe.py": recipe_bytes,
    }
    for family, rows in (extra_families or {}).items():
        objects[f"{prefix}/{family}/part-0000.parquet"] = _parquet_bytes(rows)

    files_list = [
        {
            "key": key,
            "sha256": hashlib.sha256(payload).hexdigest(),
            "size_bytes": len(payload),
            "content_type": "text/x-python"
            if key.endswith(".py")
            else "application/octet-stream",
        }
        for key, payload in objects.items()
    ]

    data_families = {}
    for family in (
        "price_coverage",
        "events",
        "event_observations",
        "source_checks",
        "earnings_observations",
        "security_history",
        "fundamentals",
        "financial_checks",
        "news_versions",
        "symbol_history",
        *(extra_families or {}),
    ):
        payload = objects[f"{prefix}/{family}/part-0000.parquet"]
        data_families[family] = {
            "schema_version": 2 if family == "events" else 1,
            "rows": pq.read_table(io.BytesIO(payload)).num_rows,
            "bytes": len(payload),
            **(family_updates or {}).get(family, {}),
        }

    manifest = {
        "schema_version": 2,
        "client_min_version": "1.0.0",
        "dataset_id": DATASET_ID,
        "cutoff_date": sessions[-1],
        "source_asof": sessions[-1],
        "producer_build_sha": "synthetic-build-sha",
        "source_timezones": {"sec": "America/New_York"},
        "universe": universe,
        "calendar": sessions,
        "bar_counts": {"raw": len(raw_rows), "all": len(all_rows)},
        "research_recipe": {
            "key": f"{prefix}/recipe.py",
            "sha256": hashlib.sha256(recipe_bytes).hexdigest(),
            "size_bytes": len(recipe_bytes),
            "content_type": "text/x-python",
        },
        "data_families": data_families,
        "files": files_list,
        **(manifest_updates or {}),
    }
    manifest_bytes = json.dumps(manifest).encode("utf-8")
    objects[f"{prefix}/manifest.json"] = manifest_bytes
    return objects, hashlib.sha256(manifest_bytes).hexdigest()


class SyntheticDatasetServer:
    def __init__(self, objects: dict[str, bytes], expected_key: str = TOKEN) -> None:
        self.objects = objects
        self.expected_key = expected_key
        self.request_count = 0
        self.request_paths: list[str] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def __enter__(self) -> Self:
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                parent.request_count += 1
                parent.request_paths.append(self.path)
                auth = self.headers.get("Authorization", "")
                if auth != f"Bearer {parent.expected_key}":
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(
                        json.dumps(
                            {
                                "error": {
                                    "code": 401,
                                    "message": "Unauthorized",
                                    "status": "UNAUTHENTICATED",
                                    "details": [
                                        {
                                            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                                            "reason": "UNAUTHORIZED",
                                        }
                                    ],
                                }
                            }
                        ).encode("utf-8")
                    )
                    return
                parsed = urlsplit(self.path)
                route = parsed.path.removeprefix("/read/v1/")
                if route == "redirect":
                    self.send_response(302)
                    self.send_header("Location", "/read/v1/redirect-target")
                    self.end_headers()
                    return
                if route == "artifact":
                    key = parse_qs(parsed.query).get("key", [""])[0]
                    payload = parent.objects.get(key)
                    if payload is None:
                        self.send_response(404)
                        self.end_headers()
                        return
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                self.send_response(404)
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=2)

    @property
    def base_url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address
        return f"http://{host}:{port}/read/v1"


class DatasetSdkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.objects, cls.manifest_sha256 = _build_synthetic_bundle()

    def test_load_and_layer1_dataframe_families(self) -> None:
        with (
            SyntheticDatasetServer(self.objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = research_datasets.load(
                DATASET_ID,
                key=TOKEN,
                base_url=server.base_url,
                cache_dir=tmp,
                preload=True,
            )

            self.assertEqual(ds.dataset_id, DATASET_ID)
            self.assertEqual(ds.manifest_sha256, self.manifest_sha256)
            self.assertEqual(len(ds.calendar), 32)
            self.assertEqual(len(ds.universe), 4)

            cal_df = ds.calendar_df(start="2026-01-06", end="2026-01-12")
            self.assertIsInstance(cal_df, pd.DataFrame)
            self.assertEqual(cal_df.columns.tolist(), ["session", "session_index"])
            self.assertTrue((cal_df["session"] >= "2026-01-06").all())

            sec_df = ds.securities(["AAPL", "GOOG", "GOOGL"], verified_only=True)
            self.assertEqual(len(sec_df), 3)
            self.assertEqual(sec_df["cik"].nunique(), 2)

            audit_df = ds.audit(symbols=["AAPL", "GOOG", "GOOGL"], strict=True)
            self.assertIsInstance(audit_df, pd.DataFrame)
            self.assertEqual(len(audit_df), 3)
            self.assertEqual(audit_df.attrs["summary"]["verified_issuers"], 2)
            self.assertEqual(audit_df.attrs["summary"]["unmapped_securities"], 0)
            self.assertTrue(audit_df["financial_check_status"].eq("checked").all())

            both_bars = ds.prices(
                ["AAPL", "GOOG"],
                start="2026-01-05",
                end="2026-01-09",
                adjusted="both",
            )
            self.assertEqual(set(both_bars["adjustment"].unique()), {"raw", "all"})

            wide_close = ds.prices(
                ["AAPL", "GOOG"],
                start="2026-01-05",
                end="2026-01-09",
                wide="close",
            )
            self.assertEqual(wide_close.columns.tolist(), ["AAPL", "GOOG"])

            q_facts = ds.fundamentals(
                ["GOOG", "GOOGL"],
                metrics=["revenue"],
                period_kind="quarter",
                active_only=True,
                by_asset=True,
            )
            self.assertIn("asset_id", q_facts.columns)
            self.assertIn("symbol", q_facts.columns)
            self.assertEqual(set(q_facts["symbol"].unique()), {"GOOG", "GOOGL"})
            self.assertEqual(q_facts.attrs["unmapped_asset_count"], 0)

            checks_by_asset = ds.financial_checks(["GOOG", "GOOGL"], by_asset=True)
            self.assertEqual(set(checks_by_asset["symbol"].unique()), {"GOOG", "GOOGL"})

            requests_after_preload = server.request_count
            _ = ds.prices(["AAPL"])
            _ = ds.events(["AAPL"])
            _ = ds.event_observations(["AAPL"])
            _ = ds.source_checks(["AAPL"])
            _ = ds.earnings(["AAPL"])
            _ = ds.security_history(["AAPL"])
            _ = ds.price_coverage(["AAPL"])
            self.assertEqual(server.request_count, requests_after_preload)

    def test_strict_audit_accepts_unchanged_and_rejects_failed_financial_checks(
        self,
    ) -> None:
        for status in ("not_changed", "error"):
            objects, _ = _build_synthetic_bundle(financial_status=status)
            with (
                self.subTest(status=status),
                SyntheticDatasetServer(objects) as server,
                tempfile.TemporaryDirectory() as tmp,
            ):
                ds = research_datasets.load(
                    DATASET_ID,
                    key=TOKEN,
                    base_url=server.base_url,
                    cache_dir=tmp,
                )
                if status == "not_changed":
                    audit = ds.audit(["AAPL"], strict=True)
                    self.assertEqual(audit["financial_check_status"].tolist(), [status])
                else:
                    with self.assertRaises(research_datasets.DatasetError) as caught:
                        ds.audit(["AAPL"], strict=True)
                    self.assertEqual(caught.exception.reason, "INTEGRITY")

    def test_layer2_pit_panels_without_preset_splits(self) -> None:
        with (
            SyntheticDatasetServer(self.objects) as server,
            tempfile.TemporaryDirectory() as tmp,
        ):
            ds = research_datasets.load(
                DATASET_ID,
                key=TOKEN,
                base_url=server.base_url,
                cache_dir=tmp,
            )

            symbols = ["AAPL", "GOOG", "GOOGL"]
            start = ds.calendar[6]
            end = ds.calendar[24]

            daily = ds.daily_features(
                symbols,
                start=start,
                end=end,
                time_policy="observed_content",
            )
            self.assertIsInstance(daily, pd.DataFrame)
            self.assertGreater(len(daily), 0)
            self.assertIn("momentum20", daily.columns)
            self.assertIn("provenance", daily.attrs)

            fund_all = ds.fundamental_features(
                daily,
                period_kind=("quarter", "annual", "instant"),
                time_policy="public_reconstructed",
            )
            self.assertIn("quarter_revenue_value", fund_all.columns)
            self.assertIn("annual_revenue_value", fund_all.columns)
            self.assertIn("instant_cash_value", fund_all.columns)

            ratios_q = ds.fundamental_ratios(
                daily,
                period_kind="quarter",
                time_policy="public_reconstructed",
            )
            self.assertIn("gross_margin_value", ratios_q.columns)
            self.assertIn("revenue_yoy_value", ratios_q.columns)

            with self.assertRaisesRegex(ValueError, "UNIVERSE_NOT_PIT"):
                ds.forward_returns(symbols, start=start, end=end, horizons=(1, 5))
            fwd = ds.forward_returns(
                symbols,
                start=start,
                end=end,
                benchmark="SPY",
                horizons=(1, 5),
                allow_static_universe=True,
            )
            self.assertIn("forward_excess_return_1d", fwd.columns)
            self.assertIn("forward_excess_return_5d", fwd.columns)
            self.assertIn("trainable_1d", fwd.columns)
            self.assertIn("trainable_5d", fwd.columns)
            self.assertEqual(set(fwd["h5_return_basis"]), {"vendor_adjusted"})
            self.assertTrue(fwd["in_universe"].isna().all())

            out_dir = Path(tmp) / "panel_out"
            panel_df = ds.panel(
                symbols,
                start=start,
                end=end,
                benchmark="SPY",
                horizons=(1, 5),
                time_policy="observed_content",
                fundamental_time_policy="public_reconstructed",
                allow_static_universe=True,
                output_dir=out_dir,
            )
            self.assertIsInstance(panel_df, pd.DataFrame)
            self.assertEqual(len(panel_df), len(daily))
            self.assertIn("symbol", panel_df.columns)
            self.assertIn("momentum20", panel_df.columns)
            self.assertIn("revenue_q_value", panel_df.columns)
            self.assertIn("revenue_ttm_value", panel_df.columns)
            self.assertIn("gross_margin_ttm_value", panel_df.columns)
            self.assertIn("forward_excess_return_5d", panel_df.columns)
            self.assertIn("alpaca_news_events_rank_21d", panel_df.columns)
            self.assertTrue((out_dir / "panel.parquet").is_file())
            provenance = json.loads((out_dir / "provenance.json").read_text())
            self.assertEqual(
                provenance["package_version"], research_datasets.__version__
            )
            self.assertEqual(provenance["parameters"]["fundamentals"], "derived")
            self.assertEqual(
                provenance["parameters"]["derivation_version"],
                research_datasets.DERIVATION_VERSION,
            )
            self.assertEqual(provenance["skipped_sources"], {"future_x": 1})
            self.assertIn(LIMITATION_PREFIX, " ".join(provenance["limitations"]))
            self.assertEqual(provenance["parameters"]["time_policy_version"], 2)
            self.assertEqual(provenance["parameters"]["universe_basis"], "static")
            self.assertIn("5", provenance["masks"])

            legacy_panel_df = ds.panel(
                symbols,
                start=start,
                end=end,
                benchmark="SPY",
                horizons=(1, 5),
                time_policy="observed_content",
                fundamental_time_policy="public_reconstructed",
                fundamentals="legacy",
                allow_static_universe=True,
            )
            self.assertIn("quarter_revenue_value", legacy_panel_df.columns)
            self.assertIn("quarter_gross_margin_value", legacy_panel_df.columns)

            # Backward-compatible prepare() works both with and without train_end/validation_end
            features_no_split, labels_no_split, splits_none, _ = (
                research_datasets.prepare(
                    ds,
                    dataset_id=DATASET_ID,
                    asset_ids=ds.resolve(symbols),
                    start=start,
                    end=end,
                    benchmark_id=ds.resolve("SPY")[0],
                    horizon=5,
                    time_policy="observed_content",
                    allow_static_universe=True,
                )
            )
            self.assertEqual(len(features_no_split), len(daily))
            self.assertEqual(len(labels_no_split), len(daily))
            self.assertIsNone(splits_none)

            features, labels, splits, provenance = research_datasets.prepare(
                ds,
                dataset_id=DATASET_ID,
                asset_ids=ds.resolve(symbols),
                start=start,
                end=end,
                benchmark_id=ds.resolve("SPY")[0],
                horizon=5,
                time_policy="observed_content",
                allow_static_universe=True,
                train_end=ds.calendar[12],
                validation_end=ds.calendar[18],
            )
            self.assertEqual(len(features), len(daily))
            self.assertEqual(len(labels), len(daily))
            self.assertIsNotNone(splits)
            self.assertEqual(provenance["manifest_sha256"], self.manifest_sha256)


if __name__ == "__main__":
    unittest.main()
