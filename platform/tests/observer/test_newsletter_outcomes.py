"""Synthetic checks for the versioned, content-free Newsletter monitor boundary."""

import copy
import unittest
from unittest.mock import patch

from personal_cloud.observer import collector

CATEGORIES = {
    "interrupted_activities": 2,
    "packets": 1,
    "workflow_attempts": 0,
    "notion_entities": 0,
    "notion_versions": 0,
    "delivery": 1,
}


def monitor(version=2):
    value = {
        "version": version,
        "worker_healthy": True,
        "drain_state": "active",
        "queued_count": 0,
        "inflight_count": 0,
        "unknown_count": 4,
        "build_source_sha": None,
        "release_request_id": None,
    }
    if version == 2:
        value.update(
            unknown_by_kind=CATEGORIES.copy(),
            unknown_revision=7,
            latest_delivery={
                "state": "provider_accepted",
                "time": "2026-10-03T02:30:00.123456+02:30",
            },
        )
    return value


def observe(value, status=200):
    with patch.object(collector, "_request", return_value=(status, value)):
        return collector.newsletter({"NEWSLETTER_MONITOR_TOKEN": "synthetic"})


class NewsletterOutcomeTests(unittest.TestCase):
    def test_configuration_identities_and_poll_times_reach_the_fleet_report(self):
        original = monitor()
        original["config_sync"] = {
            "active_revision": "a" * 40,
            "active_digest": "b" * 64,
            "wanted_revision": "a" * 40,
            "wanted_digest": "b" * 64,
            "wanted_commit": "c" * 40,
            "pinned_digest": None,
            "last_attempt": 1793254787.3939369,
            "last_success": 1793254788.8080678,
            "error": None,
        }
        untouched = copy.deepcopy(original)
        result = observe(original)
        self.assertEqual(result["state"], "healthy")
        self.assertEqual(
            result["config_sync"],
            {
                "active_revision": "a" * 40,
                "active_digest": "b" * 64,
                "wanted_revision": "a" * 40,
                "wanted_digest": "b" * 64,
                "wanted_commit": "c" * 40,
                "last_attempt_time": "2026-10-29T06:19:47.393Z",
                "last_success_time": "2026-10-29T06:19:48.808Z",
            },
        )
        self.assertEqual(result["unknown_by_kind"], CATEGORIES)
        self.assertEqual(original, untouched)

    def test_configuration_failure_and_pin_do_not_change_business_health(self):
        for config in (
            {"error": "CONFIG_GITHUB_NETWORK_ERROR"},
            {"active_revision": "packaged", "pinned_digest": "d" * 64},
        ):
            with self.subTest(config=config):
                result = observe({**monitor(), "config_sync": config})
                self.assertEqual(result["state"], "healthy")
                self.assertEqual(result["config_sync"], config)

    def test_missing_configuration_is_not_invented(self):
        for version in (1, 2):
            result = observe(monitor(version))
            self.assertNotIn("config_sync", result)
        result = observe({**monitor(), "config_sync": None})
        self.assertEqual(result["state"], "healthy")
        self.assertNotIn("config_sync", result)

    def test_invalid_configuration_is_reported_without_free_text_or_content(self):
        for config in (
            [],
            {"error": "synthetic private exception text"},
            {"active_revision": "not-a-revision"},
            {"last_attempt": True},
            {"last_success": -1},
            {"body": "synthetic private content"},
        ):
            with self.subTest(config=config):
                result = observe({**monitor(), "config_sync": config})
                self.assertEqual(result["state"], "healthy")
                self.assertEqual(
                    result["config_sync"], {"error": "CONFIG_STATUS_UNAVAILABLE"}
                )

    def test_legacy_monitor_preserves_health_without_inventing_outcomes(self):
        result = observe(monitor(1))
        self.assertEqual(result["state"], "healthy")
        self.assertEqual(result["unknown_count"], 4)
        self.assertNotIn("unknown_revision", result)
        self.assertNotIn("unknown_by_kind", result)
        self.assertNotIn("latest_delivery_state", result)

    def test_v2_normalizes_timestamp_and_preserves_classified_counts(self):
        original = monitor()
        untouched = copy.deepcopy(original)
        result = observe(original)
        self.assertEqual(result["state"], "healthy")
        self.assertEqual(result["unknown_revision"], 7)
        self.assertEqual(result["unknown_by_kind"], CATEGORIES)
        self.assertEqual(result["latest_delivery_state"], "provider_accepted")
        self.assertEqual(result["latest_delivery_time"], "2026-10-03T00:00:00.123Z")
        self.assertEqual(original, untouched)

    def test_latest_provider_result_does_not_define_process_health(self):
        for state in ("provider_accepted", "rejected", "unknown"):
            for healthy in (True, False):
                with self.subTest(state=state, healthy=healthy):
                    value = monitor()
                    value["latest_delivery"]["state"] = state
                    value["worker_healthy"] = healthy
                    result = observe(value)
                    self.assertEqual(
                        result["state"], "healthy" if healthy else "unavailable"
                    )
                    self.assertEqual(result["latest_delivery_state"], state)

    def test_no_delivery_record_is_absent_not_a_success_or_failure(self):
        value = monitor()
        value["latest_delivery"] = None
        result = observe(value)
        self.assertEqual(result["state"], "healthy")
        self.assertNotIn("latest_delivery_state", result)
        self.assertNotIn("latest_delivery_time", result)

    def test_versions_require_their_own_exact_response_shape(self):
        legacy_with_v2_fields = monitor()
        legacy_with_v2_fields["version"] = 1
        v2_without_fields = monitor(1)
        v2_without_fields["version"] = 2
        for value in (
            legacy_with_v2_fields,
            v2_without_fields,
            {**monitor(), "logs": "fixture"},
            {**monitor(), "drain_state": []},
            {**monitor(), "drain_state": {}},
        ):
            with self.subTest(value=value):
                self.assertEqual(observe(value)["state"], "unavailable")

    def test_classification_requires_fixed_keys_bounded_integers_and_exact_sum(self):
        classifications = [
            {},
            {**CATEGORIES, "unregistered": 0},
            {key: count for key, count in CATEGORIES.items() if key != "delivery"},
            {**CATEGORIES, "delivery": 2},
            {**CATEGORIES, "delivery": -1},
            {**CATEGORIES, "delivery": True},
            {**CATEGORIES, "delivery": 1.0},
            {**CATEGORIES, "delivery": 2147483648},
        ]
        for counts in classifications:
            with self.subTest(counts=counts):
                self.assertEqual(
                    observe({**monitor(), "unknown_by_kind": counts})["state"],
                    "unavailable",
                )
        for revision in (None, True, -1, 1.0, 2147483648):
            with self.subTest(revision=revision):
                self.assertEqual(
                    observe({**monitor(), "unknown_revision": revision})["state"],
                    "unavailable",
                )

    def test_malformed_delivery_returns_unavailable_instead_of_crashing(self):
        deliveries = [
            [],
            {},
            {"state": "provider_accepted"},
            {"state": "delivered", "time": "2026-10-03T00:00:00Z"},
            {"state": [], "time": "2026-10-03T00:00:00Z"},
            {"state": {}, "time": "2026-10-03T00:00:00Z"},
            {"state": "provider_accepted", "time": "2026-10-03T00:00:00"},
            {"state": "provider_accepted", "time": "invalid"},
            {"state": "provider_accepted", "time": "0001-01-01T00:00:00+01:00"},
            {"state": "provider_accepted", "time": True},
            {
                "state": "provider_accepted",
                "time": "2026-10-03T00:00:00Z",
                "body": "fixture",
            },
        ]
        for delivery in deliveries:
            with self.subTest(delivery=delivery):
                self.assertEqual(
                    observe({**monitor(), "latest_delivery": delivery})["state"],
                    "unavailable",
                )
