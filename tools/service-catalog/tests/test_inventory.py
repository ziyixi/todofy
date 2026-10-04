"""Exact inventory fails on new objects and on missing registered resources."""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalog import CatalogError
from inventory import compare, expected, observe

SYNTHETIC = {
    "workers": {"result": [{"id": "demo"}]},
    "d1": {"result": [{"uuid": "synthetic-database"}], "result_info": {"total_count": 1, "total_pages": 1, "page": 1}},
    "do": {"result": [{"id": "synthetic-namespace"}], "result_info": {"total_count": 1, "total_pages": 1, "page": 1}},
    "r2": {"result": {"buckets": [{"name": "demo-bucket"}]}, "result_info": {}},
}


class FakeApi:
    def __init__(self, responses=None):
        self.responses = responses or SYNTHETIC
        self.requests = []

    def call(self, path, **kwargs):
        self.requests.append((path, kwargs))
        kind = "workers" if path.endswith("/scripts") else (
            "d1" if "/d1/" in path else "do" if "/durable_objects/" in path else "r2")
        return self.responses[kind]


class InventoryTests(unittest.TestCase):
    def test_all_kinds_and_bootstrap_owned_state_are_registered(self):
        wanted = expected()
        self.assertIn("infra-state", wanted["r2"])
        self.assertEqual(compare(wanted, wanted), [])
        for kind in wanted:
            actual = {**wanted, kind: ["synthetic-extra"]}
            changes = compare(wanted, actual)
            self.assertEqual(sum(item["change"] == "missing" for item in changes), len(wanted[kind]))
            self.assertEqual(changes[-1]["change"], "unregistered")

    def test_cannot_claim_complete_with_a_full_page(self):
        with self.assertRaisesRegex(ValueError, "bounded account inventory"):
            observe(FakeApi({**SYNTHETIC, "workers": {"result": [{"id": str(i)} for i in range(100)]}}), "synthetic-account")

    def test_complete_inventory_retains_pagination_proof_and_uses_only_gets(self):
        api = FakeApi()
        self.assertEqual(observe(api, "synthetic-account"), {
            "workers": ["demo"], "d1": ["synthetic-database"],
            "do": ["synthetic-namespace"], "r2": ["demo-bucket"],
        })
        self.assertEqual(len(api.requests), 4)
        self.assertTrue(all(kwargs == {"include_metadata": True} for _, kwargs in api.requests))

    def test_short_page_with_remaining_results_is_not_complete(self):
        for kind, info in [
            ("r2", {"cursor": "synthetic-next-page"}),
            ("d1", {"total_count": 2, "total_pages": 2, "page": 1}),
            ("do", {"total_count": 1, "total_pages": 2, "page": 1}),
            ("do", {"total_count": 1, "total_pages": 1, "page": 2}),
        ]:
            with self.subTest(kind=kind), self.assertRaisesRegex(CatalogError, "incomplete account inventory"):
                observe(FakeApi({**SYNTHETIC, kind: {**SYNTHETIC[kind], "result_info": info}}), "synthetic-account")

    def test_r2_complete_list_may_omit_optional_pagination_metadata(self):
        response = {"result": {"buckets": [{"name": "demo-bucket"}]}}
        self.assertEqual(observe(FakeApi({**SYNTHETIC, "r2": response}), "synthetic-account")["r2"], ["demo-bucket"])

    def test_missing_pagination_or_malformed_identities_fail_closed(self):
        failures = [
            ("d1", {"result": []}),
            ("r2", {"result": {"buckets": []}, "result_info": []}),
            ("r2", {"result": {"buckets": []}, "result_info": {"cursor": False}}),
            ("workers", {"result": [{"id": ""}]}),
            ("workers", {"result": [{"id": "demo"}, {"id": "demo"}]}),
            ("do", {"result": [{"id": 1}], "result_info": {"total_count": 1}}),
            ("d1", {"result": [], "result_info": {"total_count": False}}),
            ("d1", {"result": [], "result_info": {"total_count": 0, "page": True}}),
        ]
        for kind, response in failures:
            with self.subTest(kind=kind), self.assertRaises(CatalogError):
                observe(FakeApi({**SYNTHETIC, kind: response}), "synthetic-account")

    def expected_extras(self, extras, bound_buckets=()):
        catalog = SimpleNamespace(configs={"demo": {"r2_buckets": [{"bucket_name": name} for name in bound_buckets]}},
                                  entries=[{"id": "demo"}])
        with patch("inventory.load_catalog", return_value=catalog), \
             patch("inventory.load_resources", return_value={}), \
             patch("inventory.read_toml", return_value=extras):
            return expected()

    def test_extra_bucket_has_one_known_owner(self):
        item = {"name": "demo-state", "entry": "demo", "management": "bootstrap"}
        self.assertEqual(self.expected_extras({"version": 1, "r2": [item]})["r2"], ["demo-state"])
        for change in [{"entry": "unknown"}, {"entry": []}, {"management": "automatic"}, {"management": []}]:
            with self.subTest(field=list(change)), self.assertRaisesRegex(CatalogError, "account resource ownership"):
                self.expected_extras({"version": 1, "r2": [{**item, **change}]})
        for extras, bound in [([item, item], ()), ([item], ("demo-state",))]:
            with self.assertRaisesRegex(CatalogError, "duplicate account resource ownership"):
                self.expected_extras({"version": 1, "r2": extras}, bound)

    def test_established_external_backup_owner_remains_registered(self):
        item = {"name": "legacy-backup", "entry": "self-hosted", "management": "external"}
        self.assertEqual(self.expected_extras({"version": 1, "r2": [item]})["r2"], ["legacy-backup"])
        with self.assertRaisesRegex(CatalogError, "account resource ownership"):
            self.expected_extras({"version": 1, "r2": [{**item, "management": "bootstrap"}]})

    def test_extra_bucket_names_match_r2_rules_without_echoing_invalid_values(self):
        for name in ["ab", "a" * 64, "Demo", "demo.example", "-demo", "demo-", "demo_bucket"]:
            with self.subTest(name=name), self.assertRaises(CatalogError) as error:
                self.expected_extras({"version": 1, "r2": [{"name": name, "entry": "demo", "management": "external"}]})
            self.assertNotIn(name, str(error.exception))

    def test_extra_inventory_shape_is_exact(self):
        for extras in [
            {"version": True, "r2": []}, {"version": 1, "r2": {}},
            {"version": 1, "r2": [None]}, {"version": 1, "r2": [], "adopt_all": True},
        ]:
            with self.subTest(fields=list(extras)), self.assertRaises(CatalogError):
                self.expected_extras(extras)
