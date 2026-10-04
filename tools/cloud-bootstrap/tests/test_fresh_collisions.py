"""Unknown existing objects cannot become a fresh resource's identity."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/cloud-bootstrap"))
from fresh_collisions import ENDPOINTS, MAX_PAGES, PAGE_SIZE, refuse_conflicts  # noqa: E402
from private_input import BootstrapError  # noqa: E402

ACCOUNT, ZONE = "a" * 32, "b" * 32


def plan(kind, after, actions=None):
    return {
        "resource_changes": [
            {
                "address": kind + ".synthetic",
                "type": kind,
                "change": {"actions": actions or ["create"], "after": after},
            }
        ]
    }


def page(rows, *, number=1, total=None):
    return {
        "success": True,
        "result": rows,
        "result_info": {
            "page": number,
            "per_page": 50,
            "total_count": len(rows) if total is None else total,
        },
    }


class FreshCollisions(unittest.TestCase):
    def guard(self, target, documents):
        self.calls = []
        responses = iter(documents)

        def fetch(token, path, parameters):
            self.assertEqual(token, "synthetic-private-token")
            self.calls.append((path, parameters))
            return next(responses)

        return refuse_conflicts(
            target, "synthetic-private-token", ACCOUNT, ZONE, page_fetch=fetch
        )

    def test_every_named_resource_refuses_a_same_name_without_disclosing_it(self):
        for kind, (scope, endpoint) in ENDPOINTS.items():
            if kind == "cloudflare_email_routing_rule":
                continue
            wanted = {"name": "synthetic-private-name"}
            rows = [{"name": wanted["name"], "id": "unknown-object-id"}]
            document = (
                {"success": True, "result": {"buckets": rows}, "result_info": {}}
                if kind == "cloudflare_r2_bucket"
                else page(rows)
            )
            with self.subTest(kind=kind), self.assertRaises(BootstrapError) as error:
                self.guard(plan(kind, wanted), [document])
            self.assertEqual(str(error.exception), "FRESH_RESOURCE_NAME_CONFLICT")
            self.assertEqual(error.exception.details, {"address": kind + ".synthetic"})
            self.assertNotIn(wanted["name"], str(error.exception.details))
            identity = ACCOUNT if scope == "accounts" else ZONE
            self.assertEqual(self.calls[0][0], f"/{scope}/{identity}/{endpoint}")

    def test_noop_state_objects_and_tunnel_configuration_never_scan(self):
        self.guard(
            plan("cloudflare_d1_database", {"name": "already-managed"}, ["no-op"]), []
        )
        self.assertEqual(self.calls, [])
        self.guard(plan("cloudflare_zero_trust_tunnel_cloudflared_config", {}), [])
        self.assertEqual(self.calls, [])

    def test_absence_on_all_pages_permits_creation_and_caches_by_resource_type(self):
        target = plan("cloudflare_d1_database", {"name": "new-database"})
        target["resource_changes"].append(
            plan("cloudflare_d1_database", {"name": "another-new"})["resource_changes"][
                0
            ]
        )
        self.guard(
            target,
            [
                page([{"name": "unrelated"}], total=2),
                page([{"name": "another"}], number=2, total=2),
            ],
        )
        self.assertEqual([parameters["page"] for _, parameters in self.calls], [1, 2])

    def test_later_page_collision_is_not_missed(self):
        with self.assertRaisesRegex(BootstrapError, "FRESH_RESOURCE_NAME_CONFLICT"):
            self.guard(
                plan("cloudflare_d1_database", {"name": "existing"}),
                [
                    page([{"name": "other"}], total=2),
                    page([{"name": "existing"}], number=2, total=2),
                ],
            )

    def test_access_domain_collides_even_with_a_different_application_name(self):
        kind = "cloudflare_zero_trust_access_application"
        wanted = {"name": "New app", "domain": "HOME.example.invalid/_/*"}
        for domain in (
            {"domain": "home.example.invalid/_/*"},
            {"self_hosted_domains": ["home.example.invalid/_/*"]},
            {"destinations": [{"uri": "home.example.invalid/_/*"}]},
        ):
            with (
                self.subTest(shape=domain),
                self.assertRaisesRegex(BootstrapError, "FRESH_RESOURCE_NAME_CONFLICT"),
            ):
                self.guard(
                    plan(kind, wanted), [page([{"name": "Other app", **domain}])]
                )

    def test_private_access_destination_does_not_create_a_public_domain_collision(self):
        self.guard(
            plan(
                "cloudflare_zero_trust_access_application",
                {"name": "new", "domain": "home.example.invalid"},
            ),
            [
                page(
                    [
                        {
                            "name": "other",
                            "destinations": [
                                {"type": "private", "uri": "home.example.invalid"}
                            ],
                        }
                    ]
                )
            ],
        )

    def test_dns_name_conflict_includes_a_different_record_type(self):
        with self.assertRaisesRegex(BootstrapError, "FRESH_RESOURCE_NAME_CONFLICT"):
            self.guard(
                plan(
                    "cloudflare_dns_record",
                    {"name": "Runtime.Example.Invalid", "type": "CNAME"},
                ),
                [page([{"name": "runtime.example.invalid.", "type": "AAAA"}])],
            )

    def test_email_rule_checks_exact_recipient_including_disabled_rules(self):
        matcher = {
            "type": "literal",
            "field": "to",
            "value": "private-recipient@inbox.example.invalid",
        }
        wanted = {"name": "new-rule", "matchers": [matcher]}
        with self.assertRaises(BootstrapError) as error:
            self.guard(
                plan("cloudflare_email_routing_rule", wanted),
                [page([{"name": "other", "enabled": False, "matchers": [matcher]}])],
            )
        self.assertEqual(str(error.exception), "FRESH_RESOURCE_NAME_CONFLICT")
        self.assertNotIn(matcher["value"], str(error.exception.details))
        self.guard(
            plan("cloudflare_email_routing_rule", wanted),
            [page([{"name": "new-rule", "matchers": [{"type": "all"}]}])],
        )

    def test_r2_cursor_collision_and_loop_are_detected(self):
        target = plan("cloudflare_r2_bucket", {"name": "existing"})
        first = {
            "success": True,
            "result": {"buckets": [{"name": "other"}]},
            "result_info": {"cursor": "next"},
        }
        final = {
            "success": True,
            "result": {"buckets": [{"name": "existing"}]},
            "result_info": {},
        }
        with self.assertRaisesRegex(BootstrapError, "FRESH_RESOURCE_NAME_CONFLICT"):
            self.guard(target, [first, final])
        self.assertEqual(self.calls[1][1]["cursor"], "next")
        with self.assertRaisesRegex(
            BootstrapError, "FRESH_RESOURCE_INVENTORY_INCOMPLETE"
        ):
            self.guard(target, [first, first])

    def test_r2_no_continuation_metadata_is_a_complete_bounded_page(self):
        target = plan("cloudflare_r2_bucket", {"name": "new"})
        document = {"success": True, "result": {"buckets": [{"name": "other"}]}}
        self.guard(target, [document])
        self.assertEqual(self.calls[0][1], {"per_page": PAGE_SIZE})
        document["result"]["buckets"] = [{"name": "new"}]
        with self.assertRaisesRegex(BootstrapError, "FRESH_RESOURCE_NAME_CONFLICT"):
            self.guard(target, [document])
        document["result"]["buckets"] = [{"name": "other"}] * (PAGE_SIZE + 1)
        with self.assertRaisesRegex(BootstrapError, "FRESH_RESOURCE_INVENTORY_INVALID"):
            self.guard(target, [document])

    def test_incomplete_or_malformed_inventory_cannot_authorize_create(self):
        target = plan("cloudflare_d1_database", {"name": "new"})
        for document in (
            {"success": True, "result": []},
            page([], total=1),
            page([{"name": "other"}], number=2),
            page(["malformed"]),
            {"success": True, "result": [], "result_info": {"page": 1, "per_page": 50}},
        ):
            with self.subTest(document=document), self.assertRaises(BootstrapError):
                self.guard(target, [document])
        pages = [
            page([{"name": "other"}], number=number, total=MAX_PAGES + 1)
            for number in range(1, MAX_PAGES + 1)
        ]
        with self.assertRaisesRegex(
            BootstrapError, "FRESH_RESOURCE_INVENTORY_INCOMPLETE"
        ):
            self.guard(target, pages)
        self.assertEqual(len(self.calls), MAX_PAGES)

    def test_r2_cursor_outside_metadata_is_not_mistaken_for_a_complete_page(self):
        target = plan("cloudflare_r2_bucket", {"name": "new"})
        for document in (
            {"success": True, "result": {"buckets": [], "cursor": "next"}},
            {"success": True, "result": {"buckets": []}, "cursor": "next"},
        ):
            with self.subTest(document=document), self.assertRaisesRegex(
                BootstrapError, "FRESH_RESOURCE_INVENTORY_INCOMPLETE"
            ):
                self.guard(target, [document])

    def test_unknown_planned_name_is_refused_without_provider_calls(self):
        with self.assertRaisesRegex(
            BootstrapError, "FRESH_RESOURCE_IDENTITY_UNAVAILABLE"
        ):
            self.guard(plan("cloudflare_d1_database", {"name": None}), [])
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
