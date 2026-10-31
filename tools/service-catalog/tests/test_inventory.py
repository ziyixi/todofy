"""Exact inventory fails on new objects and on missing registered resources."""

import sys
import json
import copy
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).absolute().parents[1]))
from catalog import CatalogError
import inventory
from inventory import compare, expected, observe, pending
from private_catalog import load_private_catalog, supplemental_expected, configuration_changes, attach_home_secrets

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
    def private_fixture(self):
        return json.loads((inventory.REPO / "dashboard/worker/test/fixtures/private-catalog.json").read_text())

    def attachment(self, value):
        return load_private_catalog(json.dumps(value), inventory.load_catalog(), expected(), inventory.REPO)

    def test_separate_registration_preserves_materialized_home_credentials(self):
        secrets = {"ACCESS_OWNER": "owner@example.org", "ACCESS_OWNER_ALIASES": "alias@example.org",
                   "CF_ANALYTICS_TOKEN": "synthetic-analytics-value"}
        frozen = copy.deepcopy(secrets)
        raw = json.dumps(self.private_fixture())
        self.assertEqual(attach_home_secrets(secrets, raw), {**secrets, "PRIVATE_CATALOG": raw})
        self.assertEqual(secrets, frozen)
        self.assertIs(attach_home_secrets(secrets, ""), secrets)
        with self.assertRaisesRegex(ValueError, "PRIVATE_CATALOG_INVALID"):
            attach_home_secrets(secrets, '{"invalid":"synthetic-private-value"}')
        self.assertEqual(secrets, frozen)

    def test_registration_cli_uses_the_existing_owner_only_secrets_file_and_never_prints_values(self):
        secrets = {"ACCESS_OWNER": "owner@example.org", "CF_ANALYTICS_TOKEN": "synthetic-analytics-value"}
        raw = json.dumps(self.private_fixture())
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "home-secrets.json"
            path.write_text(json.dumps(secrets))
            path.chmod(0o600)
            def call(value):
                return subprocess.run([sys.executable, str(inventory.REPO / "tools/service-catalog/private_catalog.py"),
                                       "--secrets-file", str(path)], env={**os.environ, "PRIVATE_CATALOG": value},
                                      text=True, capture_output=True, check=False)
            rejected = call('{"invalid":"synthetic-private-value"}')
            self.assertEqual(rejected.returncode, 1)
            self.assertEqual(json.loads(path.read_text()), secrets)
            self.assertEqual(rejected.stderr.strip(), "PRIVATE_CATALOG_INVALID")
            accepted = call(raw)
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertEqual(json.loads(path.read_text()), {**secrets, "PRIVATE_CATALOG": raw})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            for value in (*secrets.values(), "demo-edge-one", "synthetic-private-value"):
                self.assertNotIn(value, accepted.stdout + accepted.stderr + rejected.stdout + rejected.stderr)

    def test_private_attachment_adds_only_registered_identities(self):
        wanted = expected()
        self.assertIsNone(load_private_catalog("", None, wanted, inventory.REPO))
        attachment = self.attachment(self.private_fixture())
        merged = supplemental_expected(wanted, attachment)
        self.assertEqual(set(merged["workers"]) - set(wanted["workers"]), {"demo-edge-one", "demo-edge-two"})
        self.assertEqual(set(merged["r2"]) - set(wanted["r2"]), {"demo-store-one", "demo-store-two"})
        self.assertEqual(compare(merged, merged), [])
        actual = {**merged, "workers": [*merged["workers"], "unknown-extra"]}
        self.assertEqual(compare(merged, actual), [{"kind": "workers", "identity": "unknown-extra", "change": "unregistered"}])
        self.assertEqual(attachment["registry"]["workers"][0]["entry"], attachment["registry"]["entries"][0]["id"])

    def test_private_attachment_refuses_collisions_and_invalid_values_without_echoing_them(self):
        edits = [
            lambda value: value["registry"]["entries"][0].update(id="home"),
            lambda value: value["registry"]["workers"][0].update(script="home"),
            lambda value: value["registry"]["resources"][0].update(id="infra-state"),
            lambda value: value["registry"]["resources"][0].update(match="infra-state"),
            lambda value: value["registry"]["entries"][0]["status"].update(type="ops_v1"),
            lambda value: value["registry"]["entries"][0]["status"].update(url="https://other.example/healthz"),
            lambda value: value["desired"]["workers"]["demo-edge-one"].update(custom_domains=["home.ziyixi.science"]),
            lambda value: value["desired"].update(zones=["other.example"]),
            lambda value: value["desired"]["workers"]["demo-edge-one"]["bindings"].append({"name": "STORE", "type": "r2_bucket", "source": "config"}),
        ]
        for edit in edits:
            value = copy.deepcopy(self.private_fixture())
            edit(value)
            with self.subTest(edit=edits.index(edit)), self.assertRaisesRegex(ValueError, "^PRIVATE_CATALOG_INVALID$"):
                self.attachment(value)

    def test_private_configuration_comparison_is_read_only_and_detects_each_difference(self):
        attachment = self.attachment(self.private_fixture())

        class PrivateApi:
            def __init__(self):
                self.requests = []
                self.flags = {"enabled": False, "previews_enabled": False}

            def call(self, path):
                self.requests.append(path)
                if path.endswith("/settings"):
                    return {"bindings": [{"name": "STORE", "type": "r2_bucket", "bucket_name": "unused-private-target"}]}
                if path.endswith("/schedules"):
                    return {"schedules": []}
                if path.endswith("/subdomain"):
                    return self.flags
                if path.endswith("/domains"):
                    return [{"hostname": "demo-" + name + ".ziyixi.science", "service": "demo-edge-" + name} for name in ("one", "two")]
                if path.endswith("/routes"):
                    return []
                raise AssertionError("unexpected request")

        api = PrivateApi()
        self.assertEqual(configuration_changes(api, "synthetic-account", "synthetic-zone", attachment), 0)
        self.assertEqual(len(api.requests), 10)
        api.flags["enabled"] = True
        self.assertEqual(configuration_changes(api, "synthetic-account", "synthetic-zone", attachment), 2)

    def test_all_kinds_and_bootstrap_owned_state_are_registered(self):
        wanted = expected()
        self.assertIn("infra-state", wanted["r2"])
        self.assertEqual(compare(wanted, wanted), [])
        for kind in wanted:
            actual = {**wanted, kind: ["synthetic-extra"]}
            changes = compare(wanted, actual)
            self.assertEqual(sum(item["change"] == "missing" for item in changes), len(wanted[kind]))
            self.assertEqual(changes[-1]["change"], "unregistered")

    def test_private_mcp_namespace_is_registered_after_first_deployment(self):
        namespace = inventory.load_resources(inventory.REPO)["durable_objects"]["personal-mcp-subscriptions"]
        self.assertIn(namespace, expected()["do"])
        self.assertNotIn("personal-mcp", pending()["workers"])

    def test_a_worker_before_its_first_deploy_may_be_absent_but_nothing_else_may(self):
        """FIRST_DEPLOY_PENDING: the Worker and its buckets stay registered, absent or present; its namespaces have no
        id yet (recall/docs/design.md section 11, which the example follows)."""
        wanted = expected()
        self.assertLessEqual(set(pending()["workers"]), set(wanted["workers"]))
        with patch.object(inventory, "FIRST_DEPLOY_PENDING", {"recall"}):
            allowed = pending()
        self.assertEqual(allowed, {"workers": ["recall"], "r2": ["recall-store"]})
        self.assertLessEqual(set(allowed["r2"]), set(wanted["r2"]))
        before = {kind: [name for name in names if name not in allowed.get(kind, ())]
                  for kind, names in wanted.items()}
        self.assertEqual(compare(wanted, before, allowed), [])
        self.assertEqual(compare(wanted, wanted, allowed), [])
        self.assertEqual({item["identity"] for item in compare(wanted, before)}, {"recall", "recall-store"})
        for kind in wanted:
            actual = {**before, kind: before[kind][1:] + ["synthetic-extra"]}
            changes = compare(wanted, actual, allowed)
            with self.subTest(kind=kind):
                self.assertEqual([item["change"] for item in changes], ["missing", "unregistered"])

    def test_a_pending_workers_namespace_is_not_reported_and_no_other_is_hidden(self):
        rows = [{"id": "synthetic-pending", "script": "demo"}, {"id": "synthetic-other", "script": "other"},
                {"id": "synthetic-unnamed"}, {"id": "synthetic-odd", "script": ["demo"]}]
        api = FakeApi({**SYNTHETIC, "do": {"result": rows, "result_info": {"total_count": 4, "total_pages": 1}}})
        self.assertEqual(observe(api, "synthetic-account", {"demo"})["do"],
                         ["synthetic-odd", "synthetic-other", "synthetic-unnamed"])
        self.assertEqual(len(observe(api, "synthetic-account")["do"]), 4)

    def test_a_recorded_namespace_ends_the_pending_entry(self):
        catalog = SimpleNamespace(configs={"demo": {"durable_objects": {"bindings": [{"class_name": "RecallState"}]}}},
                                  entries=[{"id": "demo"}])
        extras = {"version": 1, "r2": []}
        with patch("inventory.load_catalog", return_value=catalog), patch("inventory.read_toml", return_value=extras), \
             patch.object(inventory, "FIRST_DEPLOY_PENDING", {"demo"}):
            with patch("inventory.load_resources", return_value={"durable_objects": {}}):
                self.assertEqual(expected()["do"], [])
            with patch("inventory.load_resources", return_value={"durable_objects": {"recall-state": "synthetic"}}), \
                 self.assertRaisesRegex(CatalogError, "first-deploy pending namespace already recorded"):
                expected()
            with patch.object(inventory, "FIRST_DEPLOY_PENDING", {"unknown"}), \
                 self.assertRaisesRegex(CatalogError, "first-deploy pending Worker"):
                pending()

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
