"""Reconcile permissions and approved-plan identity; all fixtures are synthetic."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import infra_state
import reconcile_policy
import reviewed_plans


class Classification(unittest.TestCase):
    def dns(self):
        tunnel = "a" * 8 + "-" + "b" * 4 + "-" + "c" * 4 + "-" + "d" * 4 + "-" + "e" * 12
        before = {"id": "record", "zone_id": "zone", "name": "runtime.example.invalid", "type": "CNAME",
                  "content": "wrong.example.invalid", "proxied": True, "ttl": 1}
        after = {**before, "content": tunnel + ".cfargotunnel.com"}
        return {"resource_changes": [{"address": reconcile_policy.DNS, "type": "cloudflare_dns_record",
                                      "mode": "managed", "change": {"actions": ["update"], "before": before,
                                      "after": after, "after_unknown": {"modified_on": True}}}],
                "planned_values": {"root_module": {"resources": [{"address":
                "cloudflare_zero_trust_tunnel_cloudflared.platform", "values": {"id": tunnel}}]}}}

    def test_only_owned_tunnel_dns_target_is_automatic(self):
        plan = self.dns()
        self.assertEqual(reconcile_policy.manual_reasons(plan), [])
        plan["resource_changes"][0]["change"]["after"]["content"] = "foreign.example.invalid"
        self.assertEqual(reconcile_policy.manual_reasons(plan)[0]["reason"], "DNS_TARGET_UNSAFE")

    def test_dns_identity_create_auth_and_unknown_require_review(self):
        for field, value in (("id", "new-record"), ("zone_id", "another-zone"), ("proxied", False)):
            with self.subTest(field=field):
                plan = self.dns()
                plan["resource_changes"][0]["change"]["after"][field] = value
                self.assertTrue(reconcile_policy.manual_reasons(plan))
        plan = self.dns()
        plan["resource_changes"][0]["change"]["after_unknown"]["content"] = True
        self.assertEqual(reconcile_policy.manual_reasons(plan)[0]["reason"], "UNKNOWN_OR_ADOPTION")
        plan = self.dns()
        plan["resource_changes"][0]["change"]["actions"] = ["create"]
        self.assertTrue(reconcile_policy.manual_reasons(plan))

    def test_sensitive_policy_is_never_automatic(self):
        plan = self.dns()
        plan["resource_changes"][0]["address"] = "cloudflare_zero_trust_access_policy.owner"
        self.assertEqual(reconcile_policy.manual_reasons(plan)[0]["reason"], "SENSITIVE_OR_UNSUPPORTED_RESOURCE")

    def test_nested_known_false_fields_do_not_block_safe_repair(self):
        self.assertFalse(reconcile_policy._unknown_required({"config": {"ingress": [{"hostname": False}]}, "version": True}))
        self.assertTrue(reconcile_policy._unknown_required({"config": {"ingress": [{"hostname": True}]}}))

    def test_fingerprint_binds_actual_authentication_values(self):
        plan = self.dns()
        resource = plan["resource_changes"][0]
        resource["address"] = "cloudflare_zero_trust_access_policy.owner"
        resource["change"]["after"] = {"require": [{"login_method": {"id": "original"}}]}
        original = infra_state.exact_fingerprint(plan, "synthetic-passphrase")
        resource["change"]["after"]["require"][0]["login_method"]["id"] = "different"
        self.assertNotEqual(original, infra_state.exact_fingerprint(plan, "synthetic-passphrase"))

    def test_fingerprint_ignores_unrelated_noop_d1_size(self):
        plan = self.dns()
        noop = {"address": 'cloudflare_d1_database.app["mail-hero"]', "change": {
            "actions": ["no-op"], "before": {"file_size": 10}, "after": {"file_size": 10}}}
        plan["resource_changes"].append(noop)
        first = infra_state.exact_fingerprint(plan, "synthetic-passphrase")
        noop["change"]["before"]["file_size"] = 40
        noop["change"]["after"]["file_size"] = 40
        self.assertEqual(first, infra_state.exact_fingerprint(plan, "synthetic-passphrase"))
        plan["resource_changes"][0]["change"]["after"]["proxied"] = False
        self.assertNotEqual(first, infra_state.exact_fingerprint(plan, "synthetic-passphrase"))


class Context(unittest.TestCase):
    def env(self):
        return {"GITHUB_ACTIONS": "true", "GITHUB_WORKFLOW": "Personal cloud reconcile",
                "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "workflow_dispatch"}

    def test_only_main_reconcile_actions_context(self):
        self.assertIsNone(reconcile_policy.context_problem(self.env()))
        for key, value in (("GITHUB_WORKFLOW", "other"), ("GITHUB_REF", "refs/heads/other"),
                           ("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_ACTIONS", "false")):
            self.assertIsNotNone(reconcile_policy.context_problem({**self.env(), key: value}))

    def test_workflow_run_requires_original_ci_green_same_repo_and_sha(self):
        with tempfile.TemporaryDirectory() as directory:
            event = Path(directory) / "event.json"
            run = {"name": "CI and deploy", "conclusion": "success", "head_branch": "main",
                   "head_sha": "a" * 40, "head_repository": {"full_name": "owner/cloud"}}
            env = {**self.env(), "GITHUB_EVENT_NAME": "workflow_run", "GITHUB_EVENT_PATH": str(event),
                   "GITHUB_SHA": "a" * 40, "GITHUB_REPOSITORY": "owner/cloud"}
            event.write_text(json.dumps({"workflow_run": run}))
            self.assertIsNone(reconcile_policy.context_problem(env))
            for key, value in (("name", "CI"), ("conclusion", "failure"), ("head_sha", "b" * 40),
                               ("head_repository", {"full_name": "fork/cloud"})):
                event.write_text(json.dumps({"workflow_run": {**run, key: value}}))
                self.assertEqual(reconcile_policy.context_problem(env), "RECONCILE_SOURCE_UNVERIFIED")


class SavedPlan(unittest.TestCase):
    def test_reviewed_plan_is_bound_to_sha_hash_and_expect(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            plan = work / "source.tfplan"
            plan.write_bytes(b"synthetic-encrypted-plan")
            objects = {}

            def s3(method, key, body=b""):
                if method == "HEAD":
                    return (200 if key in objects else 404), b""
                if method == "PUT":
                    objects[key] = body
                    return 200, b""
                return (200, objects[key]) if key in objects else (404, b"")

            session = SimpleNamespace(passphrase="synthetic-passphrase", work=work, s3=s3)
            env = {"GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}
            key = reviewed_plans.save(session, plan, "update=1@synthetic", env)
            self.assertEqual(reviewed_plans.read(session, key, "update=1@synthetic", env).read_bytes(), plan.read_bytes())
            for wrong_env, wrong_expect in (({**env, "GITHUB_SHA": "b" * 40}, "update=1@synthetic"),
                                           (env, "update=2@synthetic")):
                with self.assertRaises(infra_state.Refused):
                    reviewed_plans.read(session, key, wrong_expect, wrong_env)
            objects[key] = b"tampered"
            with self.assertRaisesRegex(infra_state.Refused, "CONTENT_INVALID"):
                reviewed_plans.read(session, key, "update=1@synthetic", env)


if __name__ == "__main__":
    unittest.main()
