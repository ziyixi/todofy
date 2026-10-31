"""Reconcile permissions and approved-plan identity; all fixtures are synthetic."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).absolute().parents[1] / "scripts"))
import infra_state
import reconcile_policy
import reviewed_plans


class Classification(unittest.TestCase):
    def test_k3s_api_route_uses_only_its_declared_hostname_loopback_and_runtime_audience(self):
        app, apps, gateway, console, runtime, missing = self.path_rules()
        hostname = "k3s-api.example.invalid"
        app = {**app, "destinations": [{"type": "public", "uri": app["domain"]},
                                      {"type": "public", "uri": hostname}]}
        api = {"hostname": hostname, "path": None, "service": "tcp://127.0.0.1:6443",
               "origin_request": runtime["origin_request"]}

        def check(rules, application=app, expected_host=hostname):
            return reconcile_policy._loopback_ingress(
                {"ingress": rules}, application, "synthetic", apps, expected_host)

        self.assertTrue(check([gateway, console, runtime, api, missing]))
        self.assertFalse(check([gateway, console, runtime, missing]))
        self.assertFalse(check([gateway, console, runtime, api, missing], expected_host="other.example.invalid"))
        self.assertFalse(check([gateway, console, runtime, api, missing], application={**app, "destinations": []}))
        for field, value in (("hostname", "*.example.invalid"), ("hostname", app["domain"]),
                             ("service", "tcp://10.43.0.1:443"), ("service", "https://127.0.0.1:6443"),
                             ("path", "/.*"), ("origin_request", {}), ("origin_request", None),
                             ("origin_request", {"access": None})):
            with self.subTest(field=field, value=value):
                self.assertFalse(check([gateway, console, runtime, {**api, field: value}, missing]))
        for changed in ({"required": False}, {"team_name": "foreign"}, {"aud_tag": ["b" * 64]},
                        {"aud_tag": [app["aud"], "b" * 64]}):
            with self.subTest(access=changed):
                origin = {"access": {**api["origin_request"]["access"], **changed}}
                self.assertFalse(check([gateway, console, runtime, {**api, "origin_request": origin}, missing]))
        for rules in ([api, gateway, console, runtime, missing], [gateway, console, api, runtime, missing],
                      [gateway, console, runtime, api, api, missing], [gateway, console, runtime, missing, api]):
            with self.subTest(order=[rule["service"] for rule in rules]):
                self.assertFalse(check(rules))

    def test_k3s_api_dns_repair_keeps_the_exact_declared_name_and_tunnel(self):
        plan = self.dns()
        record = plan["resource_changes"][0]
        record["address"] = 'cloudflare_dns_record.platform["k3s-api"]'
        for side in ("before", "after"):
            record["change"][side]["name"] = "k3s-api.example.invalid"
        self.assertEqual(reconcile_policy.manual_reasons(plan, "synthetic", "k3s-api.example.invalid"), [])
        self.assertTrue(reconcile_policy.manual_reasons(plan, "synthetic", "other.example.invalid"))
        record["change"]["after"]["content"] = "foreign.example.invalid"
        self.assertEqual(reconcile_policy.manual_reasons(plan, "synthetic", "k3s-api.example.invalid")[0]["reason"],
                         "DNS_TARGET_UNSAFE")

    def test_gateway_route_keeps_the_exact_path_loopback_and_origin_access(self):
        app = {"domain": "runtime.example.invalid", "aud": "a" * 64}
        gateway_app = {"domain": app["domain"] + "/api/codex/v1/*", "aud": "b" * 64}
        apps = {"cloudflare_zero_trust_access_application.codex_gateway": gateway_app}
        origin = {"access": {"required": True, "team_name": "synthetic", "aud_tag": [app["aud"]]}}
        gateway_origin = {"access": {"required": True, "team_name": "synthetic", "aud_tag": [gateway_app["aud"]]}}
        gateway = {"hostname": app["domain"], "path": "/api/codex/v1/.*",
                   "service": "http://127.0.0.1:18766", "origin_request": gateway_origin}
        runtime = {"hostname": app["domain"], "service": "http://127.0.0.1:18765", "origin_request": origin}
        ingress = {"ingress": [gateway, runtime, {"service": "http_status:404"}]}
        self.assertTrue(reconcile_policy._loopback_ingress(ingress, app, "synthetic", apps))
        self.assertFalse(reconcile_policy._loopback_ingress(ingress, app, "synthetic"))
        for field, value in (("path", "/.*"), ("service", "http://127.0.0.1:6443"),
                             ("hostname", "another.example.invalid"), ("origin_request", {})):
            with self.subTest(field=field):
                changed = {"ingress": [{**gateway, field: value}, runtime, {"service": "http_status:404"}]}
                self.assertFalse(reconcile_policy._loopback_ingress(changed, app, "synthetic", apps))

    def path_rules(self):
        """The runtime host's rules as infra/platform.tf declares them: Codex, Newsletter, the daemon, 404. A plan writes
        every attribute, an unset path as null."""
        app = {"domain": "runtime.example.invalid", "aud": "a" * 64}
        gateway_app = {"domain": app["domain"] + "/api/codex/v1/*", "aud": "b" * 64}
        console_app = {"domain": "news.example.invalid", "aud": "c" * 64, "destinations": [
            {"type": "public", "uri": "news.example.invalid"},
            {"type": "public", "uri": app["domain"] + "/api/newsletter/v1/*"}]}
        apps = {"cloudflare_zero_trust_access_application.codex_gateway": gateway_app,
                'cloudflare_zero_trust_access_application.owner["newsletter-console"]': console_app}

        def origin(audience):
            return {"access": {"required": True, "team_name": "synthetic", "aud_tag": [audience]}}

        gateway = {"hostname": app["domain"], "path": "/api/codex/v1/.*", "service": "http://127.0.0.1:18766",
                   "origin_request": origin(gateway_app["aud"])}
        console = {"hostname": app["domain"], "path": "/api/newsletter/v1/.*", "service": "http://127.0.0.1:18767",
                   "origin_request": origin(console_app["aud"])}
        runtime = {"hostname": app["domain"], "path": None, "service": "http://127.0.0.1:18765",
                   "origin_request": origin(app["aud"])}
        return app, apps, gateway, console, runtime, {"hostname": None, "path": None, "service": "http_status:404"}

    def test_the_newsletter_read_path_is_pinned_to_the_console_application(self):
        app, apps, gateway, console, runtime, missing = self.path_rules()
        check = reconcile_policy._loopback_ingress
        self.assertTrue(check({"ingress": [gateway, console, runtime, missing]}, app, "synthetic", apps))
        # Each path rule is optional (an older configuration), but never out of order, twice or after the catch-all.
        self.assertTrue(check({"ingress": [console, runtime, missing]}, app, "synthetic", apps))
        self.assertTrue(check({"ingress": [gateway, runtime, missing]}, app, "synthetic", apps))
        for order in ([console, gateway, runtime, missing], [gateway, console, console, runtime, missing],
                      [gateway, runtime, console, missing], [gateway, console, missing]):
            with self.subTest(order=[rule["service"] for rule in order]):
                self.assertFalse(check({"ingress": order}, app, "synthetic", apps))
        codex_audience = {**console, "origin_request": gateway["origin_request"]}
        for changed in ({**console, "service": "http://127.0.0.1:18765"}, {**console, "path": "/api/.*"},
                        {**console, "hostname": "news.example.invalid"}, codex_audience,
                        {**console, "origin_request": {"access": {"required": False, "team_name": "synthetic",
                                                                  "aud_tag": ["c" * 64]}}}):
            with self.subTest(changed=changed):
                self.assertFalse(check({"ingress": [gateway, changed, runtime, missing]}, app, "synthetic", apps))
        # The console's application must gate exactly that path on the runtime host.
        console_app = apps['cloudflare_zero_trust_access_application.owner["newsletter-console"]']
        for destinations in ([console_app["destinations"][0]], [{"type": "public", "uri": app["domain"] + "/api/*"}]):
            with self.subTest(destinations=destinations):
                narrowed = {**apps, 'cloudflare_zero_trust_access_application.owner["newsletter-console"]':
                            {**console_app, "destinations": destinations}}
                self.assertFalse(check({"ingress": [gateway, console, runtime, missing]}, app, "synthetic", narrowed))
        # The daemon's catch-all has no path.
        self.assertFalse(check({"ingress": [gateway, console, {**runtime, "path": "/.*"}, missing]}, app, "synthetic", apps))

    def test_the_tunnel_repair_reads_the_console_application_from_the_plan(self):
        app, apps, gateway, console, runtime, missing = self.path_rules()
        tunnel_id = "a" * 8 + "-" + "b" * 4 + "-" + "c" * 4 + "-" + "d" * 4 + "-" + "e" * 12
        identity = {"id": tunnel_id, "account_id": "account", "tunnel_id": tunnel_id}
        resources = [{"address": 'cloudflare_zero_trust_access_application.platform_machine["runtime"]', "values": app}]
        resources += [{"address": address, "values": values} for address, values in apps.items()]
        plan = {"planned_values": {"root_module": {"resources": resources}},
                "resource_changes": [{"address": reconcile_policy.TUNNEL_CONFIG, "mode": "managed", "change": {
                    "actions": ["update"], "after_unknown": {"version": True},
                    "before": {**identity, "config": {"ingress": [gateway, runtime, missing]}},
                    "after": {**identity, "config": {"ingress": [gateway, console, runtime, missing]}}}}]}
        self.assertEqual(reconcile_policy.manual_reasons(plan, "synthetic"), [])
        resources.pop()
        self.assertEqual(reconcile_policy.manual_reasons(plan, "synthetic")[0]["reason"], "CONNECTOR_TARGET_UNSAFE")

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
