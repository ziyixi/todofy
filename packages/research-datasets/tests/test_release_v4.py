"""Release format v4: profiles, recomputed surrogates, event_text and the natural-key audit.

A v4 bundle here is the synthetic v3 bundle re-encoded the way the freeze writes v4:
hash and surrogate columns cut, ``fact_id`` and ``version_id`` named in
``derived_columns``, event text moved to ``event_text``. Every read must equal the v3
read minus the cut columns.
"""

from __future__ import annotations

import hashlib
import io
import json
import tempfile
import unittest
from unittest import mock

import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from pandas.testing import assert_frame_equal

import research_datasets
from research_datasets import client, surrogates
from tests import test_sdk as fixture

PREFIX = f"datasets/{fixture.DATASET_ID}"
TEXT = ["title", "summary", "source_url"]
CUTS = {
    "fundamentals": ["observation_id", "content_hash", "fact_id"],
    "event_observations": ["observation_id", "content_hash", *TEXT],
    "news_versions": ["version_id"],
    "earnings_observations": ["observation_id", "content_hash"],
    "security_history": ["observation_id"],
}
V4_SCHEMAS = {
    "fundamentals": 2,
    "event_observations": 3,
    "news_versions": 2,
    "earnings_observations": 2,
    "security_history": 2,
    "event_text": 1,
}
DERIVED = {
    "fundamentals": {"fact_id": "sha256-json-v1"},
    "news_versions": {"version_id": "sha256-pipe-v1"},
}
POLICIES = research_datasets.POLICIES
S = fixture.SESSIONS


def _part(family: str) -> str:
    return f"{PREFIX}/{family}/part-0000.parquet"


def _read(objects: dict[str, bytes], family: str) -> pa.Table:
    return pq.read_table(io.BytesIO(objects[_part(family)]))


def _write(objects: dict[str, bytes], family: str, table: pa.Table) -> None:
    buf = io.BytesIO()
    pq.write_table(table, buf)
    objects[_part(family)] = buf.getvalue()


def _set(table: pa.Table, name: str, values: pa.Array) -> pa.Table:
    if name in table.column_names:
        return table.set_column(table.column_names.index(name), name, values)
    return table.append_column(name, values)


def _manifest(objects: dict[str, bytes], **updates: object) -> dict[str, bytes]:
    """Re-register every part (SHA-256, size, rows) and apply manifest updates."""
    manifest = json.loads(objects[f"{PREFIX}/manifest.json"])
    manifest.update(updates)
    families = manifest["data_families"]
    for family in list(families):
        if _part(family) not in objects:
            del families[family]
    for key, payload in objects.items():
        family = key.removeprefix(f"{PREFIX}/").split("/")[0]
        if key.endswith(".parquet") and family not in ("raw", "all"):
            families.setdefault(family, {"schema_version": 1})
            families[family]["rows"] = pq.read_table(io.BytesIO(payload)).num_rows
    manifest["files"] = [
        {
            "key": key,
            "sha256": hashlib.sha256(payload).hexdigest(),
            "size_bytes": len(payload),
            "content_type": "text/x-python"
            if key.endswith(".py")
            else "application/octet-stream",
        }
        for key, payload in objects.items()
        if not key.endswith("manifest.json")
    ]
    objects[f"{PREFIX}/manifest.json"] = json.dumps(manifest).encode()
    return objects


def _observations() -> list[dict[str, object]]:
    """Versions with a text change, a links-only change and text needing escapes."""
    rows = fixture.default_observations()
    for row in rows:
        row.update(title=f"T {row['event_uid']}", summary="", source_url="u://1")
    later = dict(rows[1], observation_sequence=2, asset_ids=[fixture.ASSET_A])
    later.update(
        observation_id="obs-news-1-2", observation_recorded_at=f"{S[9]}T15:00:00Z"
    )
    changed = dict(later, observation_sequence=3, title='Héllo "x" \\ y', summary="s")
    changed.update(
        observation_id="obs-news-1-3",
        content_first_seen_at=f"{S[11]}T15:00:00Z",
        observation_recorded_at=f"{S[11]}T15:00:00Z",
    )
    return [*rows, later, changed]


def v3_bundle() -> dict[str, bytes]:
    """The synthetic v3 bundle with formula-true fact_id and version_id and event text."""
    objects, _ = fixture._build_synthetic_bundle()
    facts = _read(objects, "fundamentals")
    facts = _set(facts, "taxonomy", pa.array(["us-gaap"] * facts.num_rows))
    facts = _set(facts, "fact_id", surrogates.fact_ids(facts))
    _write(objects, "fundamentals", facts)
    news = _read(objects, "news_versions")
    for name in ("headline_sha256", "summary_sha256"):
        news = _set(news, name, pa.array([name[0] * 64] * news.num_rows))
    _write(
        objects, "news_versions", _set(news, "version_id", surrogates.version_ids(news))
    )
    schema = fixture.OBSERVATION_SCHEMA
    for name in TEXT:
        schema = schema.append(pa.field(name, pa.string()))
    observations = pa.Table.from_pylist(_observations(), schema=schema)
    _write(objects, "event_observations", observations)
    return _manifest(objects)


def event_text(observations: pa.Table) -> pa.Table:
    """First version of each event_uid and every later version whose text changed."""
    frame = observations.to_pandas().sort_values(["event_uid", "observation_sequence"])
    changed = frame[TEXT].ne(frame.groupby("event_uid")[TEXT].shift()).any(axis=1)
    kept = frame[changed][["event_uid", "observation_sequence", *TEXT]]
    return pa.Table.from_pandas(kept, preserve_index=False)


def to_v4(
    v3: dict[str, bytes],
    *,
    profile: str = "full",
    omit: tuple[str, ...] = (),
    **updates: object,
) -> dict[str, bytes]:
    objects = dict(v3)
    _write(objects, "event_text", event_text(_read(objects, "event_observations")))
    for family, cut in CUTS.items():
        table = _read(objects, family)
        _write(objects, family, table.drop([c for c in cut if c in table.column_names]))
    for family in omit:
        del objects[_part(family)]
    _manifest(objects)
    manifest = json.loads(objects[f"{PREFIX}/manifest.json"])
    for family, version in V4_SCHEMAS.items():
        if family in manifest["data_families"]:
            manifest["data_families"][family]["schema_version"] = version
    return _manifest(
        objects,
        data_families=manifest["data_families"],
        profile=profile,
        client_min_version="2.4.0",
        derived_columns=DERIVED,
        relocated_columns={"event_observations": {"event_text": TEXT}},
        **updates,
    )


class Session:
    """One served bundle and its loaded version."""

    def __init__(self, objects: dict[str, bytes]) -> None:
        self.server = fixture.SyntheticDatasetServer(objects)
        self.tmp = tempfile.TemporaryDirectory()

    def __enter__(self) -> research_datasets.Dataset:
        self.server.__enter__()
        return research_datasets.load(
            fixture.DATASET_ID,
            key=fixture.TOKEN,
            base_url=self.server.base_url,
            cache_dir=self.tmp.name,
        )

    def __exit__(self, *exc: object) -> None:
        self.server.__exit__(*exc)
        self.tmp.cleanup()


class SurrogateFormulaTest(unittest.TestCase):
    def test_fact_id_matches_json_dumps_for_every_kind_of_text(self) -> None:
        values = [
            ["0000000101", "us-gaap", "Revenues", "USD", "", "2025-12-31", "0001-26-1"],
            ["0000000101", "dei", 'Tag"Quote', "USD", "2025-01-01", "2025-12-31", "a"],
            ["0000000101", "ifrs", "Back\\slash", "EUR", "", "2025-12-31", "b"],
            ["0000000101", "ifrs", "Ümlaut", "EUR", "", "2025-12-31", "c"],
            ["0000000101", "ifrs", "Tab\there", "EUR", "", "2025-12-31", "d"],
            ["0000000101", "ifrs", "Del\x7f~", "EUR", "", "2025-12-31", "g"],
            ["0000000101", "ifrs", "emoji \U0001f600", "EUR", "", "2025-12-31", "e"],
            ["0000000101", "us-gaap", "Cash", "USD", None, "2025-12-31", "f"],
        ]
        table = pa.Table.from_pylist(
            [dict(zip(surrogates.FACT_ID_FIELDS, row)) for row in values]
        )
        expected = [
            hashlib.sha256(json.dumps(row, separators=(",", ":")).encode()).hexdigest()
            for row in values
        ]
        self.assertEqual(surrogates.fact_ids(table).to_pylist(), expected)
        self.assertEqual(surrogates.fact_ids(table.slice(0, 0)).to_pylist(), [])

    def test_recompute_in_slices_equals_one_pass(self) -> None:
        table = pa.Table.from_pylist(
            [
                dict(
                    zip(
                        surrogates.FACT_ID_FIELDS,
                        ["0000000101", "us-gaap", f"Tag{i}", "USD"]
                        + [None if i == 3 else "", "2025-12-31", f'a"{i}'],
                    )
                )
                for i in range(7)
            ]
        )
        formula = surrogates.FORMULAS["sha256-json-v1"]
        with mock.patch.object(surrogates, "SLICE_ROWS", 3):
            sliced = surrogates.derive(formula, table)
            empty = surrogates.derive(formula, table.slice(0, 0))
        self.assertEqual(sliced.num_chunks, 3)
        self.assertEqual(sliced.to_pylist(), surrogates.fact_ids(table).to_pylist())
        self.assertEqual((empty.type, len(empty)), (pa.string(), 0))

    def test_version_id_matches_the_writer_rule(self) -> None:
        row = {
            "event_id": "alpaca_news:1",
            "provider_updated_at": "2026-01-02T00:00:00Z",
        }
        row.update(headline_sha256="a" * 64, summary_sha256="b" * 64)
        expected = hashlib.sha256("|".join(row.values()).encode()).hexdigest()
        table = pa.Table.from_pylist([row])
        self.assertEqual(surrogates.version_ids(table).to_pylist(), [expected])
        with self.assertRaises(ValueError):
            surrogates.version_ids(pa.Table.from_pylist([dict(row, event_id=None)]))

    def test_version_id_reproduces_the_collector_writer(self) -> None:
        """Two rows the collector's news writer wrote, ids included (formula F5 of the
        storage v4 design, from the collector's frozen surrogate fixture)."""
        headline = "3f129db1c99d5196b657c1ef3aeb3c0346031993a43ef3a7544a9d0b227e164e"
        rows = [
            {
                "event_id": "alpaca_news:42",
                "provider_updated_at": "2026-02-05T21:00:00Z",
                "headline_sha256": headline,
                "summary_sha256": "11507a0e2f5e69d5dfa40a62a1bd7b6e"
                "e57e6bcd85c67c9b8431b36fff21c437",
                "id": "66a5e314790f6e0f9234410fbd1f3a35"
                "16b0cd89e64901a65ae76af78b2fb073",
            },
            {
                "event_id": "alpaca_news:42",
                "provider_updated_at": "",
                "headline_sha256": headline,
                "summary_sha256": "761b7ad8ad439b2855fcbb611331c646"
                "ef0870b0631247bba3f3025cb6df5a53",
                "id": "67e238a63445256cb470012bffeb5927"
                "68501c750c530ad36061ebf30b7f697a",
            },
        ]
        self.assertEqual(
            surrogates.version_ids(pa.Table.from_pylist(rows)).to_pylist(),
            [row["id"] for row in rows],
        )


class ReleaseV4Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.v3 = v3_bundle()
        cls.v4 = to_v4(cls.v3)

    def test_older_sdk_refuses_and_this_one_reads(self) -> None:
        manifest = json.loads(self.v4[f"{PREFIX}/manifest.json"])
        research_datasets.check_manifest(manifest)
        with (
            mock.patch.object(client, "__version__", "2.3.1"),
            self.assertRaises(research_datasets.DatasetError) as caught,
        ):
            research_datasets.check_manifest(manifest)
        self.assertEqual(caught.exception.reason, "CLIENT_TOO_OLD")
        for field, value in (
            ("profile", ""),
            ("derived_columns", {"fundamentals": ["fact_id"]}),
            ("derived_columns", {"fundamentals": {"fact_id": 1}}),
            ("relocated_columns", {"event_observations": {"event_text": "title"}}),
        ):
            with self.subTest(field=field):
                with self.assertRaises(research_datasets.DatasetError) as caught:
                    research_datasets.check_manifest(dict(manifest, **{field: value}))
                self.assertEqual(caught.exception.reason, "INTEGRITY")

    def test_family_reads_equal_v3_minus_the_cut_columns(self) -> None:
        with (
            mock.patch.object(surrogates, "SLICE_ROWS", 2),
            Session(self.v3) as old,
            Session(self.v4) as new,
        ):
            for family in ("fundamentals", "news_versions", "earnings_observations"):
                with self.subTest(family=family):
                    expected = old.family(family).drop(
                        columns=[
                            c for c in CUTS[family] if c not in DERIVED.get(family, {})
                        ],
                        errors="ignore",
                    )
                    assert_frame_equal(new.family(family), expected, check_exact=True)
            columns = ["cik", "fact_id", "observation_sequence"]
            assert_frame_equal(
                new.fundamentals(columns=columns),
                old.fundamentals(columns=columns),
                check_exact=True,
            )
            assert_frame_equal(
                pd.concat(new.iter_fundamentals(), ignore_index=True),
                pd.concat(old.iter_fundamentals(), ignore_index=True).drop(
                    columns=["observation_id"]
                ),
                check_exact=True,
            )
            assert_frame_equal(
                pd.concat(new.iter_fundamentals(columns=["fact_id", "tag"])),
                pd.concat(old.iter_fundamentals(columns=["fact_id", "tag"])),
                check_exact=True,
            )

    def test_event_text_as_of_each_version(self) -> None:
        with Session(self.v3) as old, Session(self.v4) as new:
            text = new.family("event_text")
            news = text[text["event_uid"] == "news-1"]
            # The links-only version 2 adds no text row; version 3 changed the text.
            self.assertEqual(news["observation_sequence"].tolist(), [1, 3])
            full = new.event_observations(with_text=True)
            expected = old.event_observations().drop(columns=["observation_id"])
            assert_frame_equal(full, expected[full.columns], check_exact=True)
            self.assertEqual(full.columns[-3:].tolist(), TEXT)
            plain = new.event_observations()
            self.assertFalse(set(TEXT) & set(plain.columns))
            assert_frame_equal(plain, full.drop(columns=TEXT), check_exact=True)
            for columns in (["title", "event_uid"], ["summary"], ["source"]):
                with self.subTest(columns=columns):
                    assert_frame_equal(
                        new.event_observations(["GOOG"], columns=columns),
                        old.event_observations(["GOOG"], columns=columns),
                        check_exact=True,
                    )
            for window in ({"start": S[9], "end": S[11]}, {"start": S[0], "end": S[0]}):
                with self.subTest(window=window):
                    expected = old.event_observations(**window)
                    assert_frame_equal(
                        new.event_observations(**window, with_text=True),
                        expected[full.columns],
                        check_exact=True,
                    )
            # The empty window still has typed columns: text columns typed as stored.
            self.assertTrue(expected.empty)
            self.assertIn("title", expected.columns)
            # On a v3 release the stored text is the text.
            assert_frame_equal(
                old.event_observations(with_text=True), old.event_observations()
            )

    def test_missing_event_text_is_refused(self) -> None:
        objects = dict(self.v4)
        text = _read(objects, "event_text")
        _write(
            objects,
            "event_text",
            text.filter(pc.not_equal(text["event_uid"], "news-1")),
        )
        with Session(_manifest(objects)) as ds:
            with self.assertRaises(research_datasets.DatasetError) as caught:
                ds.event_observations(with_text=True)
            self.assertEqual(caught.exception.reason, "INTEGRITY")
        objects = dict(self.v4)
        _write(objects, "event_text", _read(objects, "event_text").drop(["summary"]))
        with Session(_manifest(objects)) as ds:
            with self.assertRaises(research_datasets.DatasetError) as caught:
                ds.event_observations(with_text=True)
            self.assertEqual(caught.exception.reason, "INTEGRITY")

    def test_text_relocation_must_be_one_this_sdk_joins_back(self) -> None:
        """Schema 3 text is stored or moved to event_text; any other move is refused."""
        for relocated in (
            {"event_observations": {"event_texts": TEXT}},
            {"event_observations": {"event_text": [*TEXT, "body"]}},
            {"news_versions": {"event_text": TEXT}},
            {},
        ):
            objects = _manifest(dict(self.v4), relocated_columns=relocated)
            with self.subTest(relocated=relocated), Session(objects) as ds:
                for options in ({"with_text": True}, {"columns": ["title"]}, {}):
                    with self.assertRaises(research_datasets.DatasetError) as caught:
                        ds.event_observations(**options)
                    self.assertEqual(caught.exception.reason, "INTEGRITY")
        relocated = {"news_versions": {"event_text": TEXT}}
        with Session(_manifest(dict(self.v4), relocated_columns=relocated)) as ds:
            with self.assertRaises(research_datasets.DatasetError) as caught:
                ds.family("news_versions")
            self.assertEqual(caught.exception.reason, "INTEGRITY")
        # The freeze's fallback: schema 3 still stores its text and relocates none.
        observations = _read(self.v3, "event_observations")
        cut = [c for c in CUTS["event_observations"] if c not in TEXT]
        objects = dict(self.v4)
        _write(
            objects,
            "event_observations",
            observations.drop([c for c in cut if c in observations.column_names]),
        )
        with (
            Session(self.v3) as old,
            Session(_manifest(objects, relocated_columns={})) as new,
        ):
            expected = old.event_observations().drop(columns=cut, errors="ignore")
            for options in ({"with_text": True}, {}):
                assert_frame_equal(
                    new.event_observations(**options), expected, check_exact=True
                )

    def test_fact_id_must_be_stored_or_derived(self) -> None:
        """Cutting fact_id without naming its formula is refused: no fact is dropped."""
        derived = {"news_versions": DERIVED["news_versions"]}
        with Session(_manifest(dict(self.v4), derived_columns=derived)) as ds:
            for name, read in (
                ("fundamentals", ds.fundamentals),
                ("iter_fundamentals", lambda: list(ds.iter_fundamentals())),
                (
                    "fundamental_states",
                    lambda: ds.fundamental_states(time_policy=POLICIES[0]),
                ),
                ("audit", lambda: ds.audit(["AAPL", "GOOG", "GOOGL"])),
            ):
                with self.subTest(read=name):
                    with self.assertRaises(research_datasets.DatasetError) as caught:
                        read()
                    self.assertEqual(caught.exception.reason, "INTEGRITY")

    def test_stored_column_wins_and_unknown_formulas_are_refused(self) -> None:
        objects = dict(self.v4)
        facts = _read(objects, "fundamentals")
        _write(
            objects,
            "fundamentals",
            facts.append_column("fact_id", pa.array(["kept"] * facts.num_rows)),
        )
        with Session(_manifest(objects)) as ds:
            self.assertEqual(set(ds.fundamentals()["fact_id"]), {"kept"})
        for derived in (
            {"fundamentals": {"fact_id": "sha256-json-v9"}},
            {"fundamentals": {"fact_id": "sha256-pipe-v1"}},
        ):
            with (
                self.subTest(derived=derived),
                Session(_manifest(dict(self.v4), derived_columns=derived)) as ds,
            ):
                with self.assertRaises(research_datasets.DatasetError) as caught:
                    ds.fundamentals()
                self.assertEqual(caught.exception.reason, "INTEGRITY")
                with self.assertRaises(research_datasets.DatasetError):
                    list(ds.iter_fundamentals())

    def test_families_outside_the_profile_raise(self) -> None:
        omit = ("events", "security_history", "price_coverage")
        with Session(to_v4(self.v3, profile="training", omit=omit)) as ds:
            for read in (
                ds.events,
                lambda: ds.family("events"),
                lambda: ds.family("security_history"),
                ds.security_history,
                ds.price_coverage,
            ):
                with self.assertRaises(research_datasets.DatasetError) as caught:
                    read()
                self.assertEqual(caught.exception.reason, "CAPABILITY_MISSING")
                self.assertIn("not in profile training", str(caught.exception))
            self.assertFalse(ds.event_observations().empty)
        # Without a profile a version without events still reads as no events.
        legacy = dict(self.v3)
        del legacy[_part("events")]
        with Session(_manifest(legacy)) as ds:
            self.assertTrue(ds.events().empty)

    def test_audit_checks_the_natural_key(self) -> None:
        symbols = ["AAPL", "GOOG", "GOOGL"]
        with Session(self.v3) as old, Session(self.v4) as new:
            before, after = (
                old.audit(symbols, strict=True),
                new.audit(symbols, strict=True),
            )
            assert_frame_equal(after, before, check_exact=True)
            changed = {"manifest_sha256", "family_rows"}
            self.assertEqual(
                {k: v for k, v in after.attrs["summary"].items() if k not in changed},
                {k: v for k, v in before.attrs["summary"].items() if k not in changed},
            )
        objects = dict(self.v4)
        facts = _read(objects, "fundamentals")
        _write(objects, "fundamentals", pa.concat_tables([facts, facts.slice(0, 1)]))
        with Session(_manifest(objects)) as ds:
            summary = ds.audit(symbols).attrs["summary"]
            self.assertFalse(summary["fact_sequence_unique"])
            self.assertFalse(summary["observation_id_unique"])
            with self.assertRaises(research_datasets.DatasetError) as caught:
                ds.audit(symbols, strict=True)
            self.assertNotIn("observation_id", str(caught.exception))
            self.assertIn("(fact_id, observation_sequence)", str(caught.exception))

    def test_features_and_panels_equal_v3_under_both_policies(self) -> None:
        symbols = ["AAPL", "GOOG", "GOOGL"]
        window = {"start": S[6], "end": S[24]}
        with Session(self.v3) as old, Session(self.v4) as new:
            for policy in POLICIES:
                with self.subTest(policy=policy):
                    outputs = []
                    for ds in (old, new):
                        daily = ds.daily_features(symbols, **window, time_policy=policy)
                        outputs.append(
                            {
                                "daily": daily,
                                "legacy": ds.fundamental_features(
                                    daily,
                                    period_kind=("quarter", "annual", "instant"),
                                    time_policy=policy,
                                ),
                                "ratios": ds.fundamental_ratios(
                                    daily, time_policy=policy
                                ),
                                "derived": ds.derived_fundamentals(
                                    daily, time_policy=policy, provenance=True
                                ),
                                "panel": ds.panel(
                                    symbols,
                                    **window,
                                    horizons=(1, 5),
                                    time_policy=policy,
                                    allow_static_universe=True,
                                ),
                            }
                        )
                    for name, frame in outputs[0].items():
                        with self.subTest(output=name):
                            assert_frame_equal(
                                outputs[1][name], frame, check_exact=True
                            )


if __name__ == "__main__":
    unittest.main()
