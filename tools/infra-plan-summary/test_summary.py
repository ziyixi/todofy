"""Tests for summary.py: python3 -m unittest discover -s tools/infra-plan-summary

The sentinel values stand in for personal data (an Access policy email, a TXT verification value, the
account id inside an import id). They are planted everywhere `tofu show -json` can carry a value; the
summary must never contain any of them, whatever the plan looks like.
"""

import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import summary  # noqa: E402

SCRIPT = Path(__file__).with_name("summary.py")
SENTINELS = (
    "sentinel-owner@example.invalid",
    "sentinel-verification=7f3c9e1d2b",
    "5e171e1000000000000000000000beef",
)
EMAIL, TXT, ACCOUNT = SENTINELS


def change(actions, before=None, after=None, importing=None):
    result = {
        "actions": actions,
        "before": before,
        "after": after,
        "after_unknown": {},
        "before_sensitive": {"include": [{"email": {"email": True}}]},
        "after_sensitive": {"include": [{"email": {"email": True}}]},
    }
    if importing:
        result["importing"] = {"id": importing}
    return result


POLICY = {"account_id": ACCOUNT, "name": "owner", "include": [{"email": {"email": EMAIL}}]}
RECORD = {"zone_id": ACCOUNT, "type": "TXT", "content": TXT, "comment": EMAIL}


def plan():
    """A synthetic plan in the shape of `tofu show -json`, with sentinels in every value position."""
    changed = dict(POLICY, include=[{"email": {"email": "other-" + EMAIL}}])
    return {
        "format_version": "1.2",
        "terraform_version": "1.12.6",
        "variables": {"access_owner_emails": {"value": [EMAIL]}, "account_id": {"value": ACCOUNT}},
        "planned_values": {"root_module": {"resources": [{"address": "x.y", "values": POLICY}]}},
        "prior_state": {"values": {"root_module": {"resources": [{"values": RECORD}]}}},
        "configuration": {"root_module": {"variables": {"txt": {"default": TXT}}}},
        "resource_changes": [
            {"address": "cloudflare_zero_trust_access_policy.owner", "change": change(["no-op"], POLICY, POLICY, f"{ACCOUNT}/policy")},
            {"address": 'cloudflare_d1_database.app["mail-hero"]', "change": change(["no-op"], RECORD, RECORD)},
            {"address": "cloudflare_zero_trust_access_policy.github_owner", "change": change(["update"], POLICY, changed)},
            {"address": 'cloudflare_r2_bucket.app["todofy-backups"]', "change": change(["delete", "create"], RECORD, RECORD)},
            {"address": "cloudflare_dns_record.verification", "change": change(["delete"], RECORD, None)},
            {"address": "cloudflare_zero_trust_access_application.new", "change": change(["create"], None, POLICY)},
            {"address": "cloudflare_zero_trust_access_application.adopted", "change": change(["update"], POLICY, changed, f"accounts/{ACCOUNT}/app")},
            # A for_each key that is a personal value: the address itself must be withheld.
            {"address": f'cloudflare_dns_record.by_value["{EMAIL}"]', "change": change(["create"], None, RECORD)},
            {"address": f'cloudflare_dns_record.by_value["{TXT}"]', "change": change(["create"], None, RECORD)},
        ],
        "resource_drift": [
            {"address": "cloudflare_zero_trust_access_policy.owner", "change": change(["update"], POLICY, changed)},
        ],
        "output_changes": {
            "access_aud": change(["update"], {"x": EMAIL}, {"x": TXT}),
            "unchanged": change(["no-op"], ACCOUNT, ACCOUNT),
        },
    }


def run(data, *args):
    out, err = io.StringIO(), io.StringIO()
    text = data if isinstance(data, str) else json.dumps(data)
    code = summary.main(list(args), stdin=io.StringIO(text), stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


class NeverPrintsValues(unittest.TestCase):
    def assert_clean(self, *texts):
        for text in texts:
            for sentinel in SENTINELS:
                self.assertNotIn(sentinel, text)
            # No fragment of the email either (local part, domain).
            self.assertNotIn("sentinel-owner", text)
            self.assertNotIn("example.invalid", text)
            self.assertNotIn("7f3c9e1d2b", text)

    def test_the_summary_of_a_plan_full_of_sentinels_contains_none(self):
        for flags in ((), ("--all",), ("--fail-on-destroy",), ("--all", "--fail-on-destroy")):
            with self.subTest(flags=flags):
                code, out, err = run(plan(), *flags)
                self.assertIn(code, (0, 3))
                self.assert_clean(out, err)
                self.assertIn(summary.WITHHELD, out)

    def test_invalid_input_is_never_quoted(self):
        for text in (f'{{"format_version": "1.2", "resource_changes": [{{"address": "{EMAIL}"', TXT, EMAIL,
                     json.dumps({"variables": {"x": {"value": EMAIL}}}),
                     json.dumps({"format_version": "1.2", "resource_changes": [{"address": "a.b", "change": EMAIL}]}),
                     json.dumps({"format_version": "1.2", "resource_changes": EMAIL})):
            with self.subTest(text=text[:20]):
                code, out, err = run(text)
                self.assertEqual(code, 2)
                self.assertEqual(out, "")
                self.assert_clean(err)

    def test_the_command_line_entry_point_is_clean_too(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "plan.json")
            Path(path).write_text(json.dumps(plan()))
            result = subprocess.run([sys.executable, str(SCRIPT), "--all", path], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0)
        self.assert_clean(result.stdout, result.stderr)
        self.assertIn("cloudflare_zero_trust_access_policy.owner", result.stdout)

    def test_a_missing_file_is_reported_without_its_name(self):
        out, err = io.StringIO(), io.StringIO()
        code = summary.main([f"/nonexistent/{EMAIL}.json"], stdout=out, stderr=err)
        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue(), "")
        self.assert_clean(err.getvalue())


class Actions(unittest.TestCase):
    def test_counts_and_rows(self):
        code, out, _ = run(plan())
        self.assertEqual(code, 0)
        self.assertIn("import: 2, create: 3, update: 2, replace: 1, delete: 1, forget: 0, read: 0, no-op: 1", out)
        self.assertIn("changed outside OpenTofu: 1; output changes: 1", out)
        self.assertIn("| import | `cloudflare_zero_trust_access_policy.owner` |", out)
        self.assertIn("| import+update | `cloudflare_zero_trust_access_application.adopted` |", out)
        self.assertIn('| replace | `cloudflare_r2_bucket.app["todofy-backups"]` |', out)
        self.assertIn("| delete | `cloudflare_dns_record.verification` |", out)
        self.assertIn("| `access_aud` | update |", out)
        self.assertNotIn("`unchanged`", out)
        # no-op rows only with --all
        self.assertNotIn('cloudflare_d1_database.app["mail-hero"]', out)
        self.assertIn('| no-op | `cloudflare_d1_database.app["mail-hero"]` |', run(plan(), "--all")[1])

    def test_a_clean_plan(self):
        clean = plan()
        clean["resource_changes"] = [clean["resource_changes"][1]]
        clean["resource_drift"], clean["output_changes"] = [], {}
        code, out, _ = run(clean, "--fail-on-destroy")
        self.assertEqual(code, 0)
        self.assertIn("No resource changes.", out)
        self.assertIn("import: 0, create: 0, update: 0, replace: 0, delete: 0, forget: 0, read: 0, no-op: 1", out)

    def test_fail_on_destroy(self):
        self.assertEqual(run(plan(), "--fail-on-destroy")[0], 3)
        self.assertEqual(run(plan())[0], 0)
        for actions in (["delete"], ["delete", "create"], ["create", "delete"], ["forget"]):
            with self.subTest(actions=actions):
                one = copy.deepcopy(plan())
                one["resource_changes"] = [{"address": "a.b", "change": change(actions)}]
                self.assertEqual(run(one, "--fail-on-destroy")[0], 3)
        harmless = copy.deepcopy(plan())
        harmless["resource_changes"] = [{"address": "a.b", "change": change(["update"], importing="x")}]
        self.assertEqual(run(harmless, "--fail-on-destroy")[0], 0)

    def test_an_unknown_action_combination_is_a_change(self):
        self.assertEqual(summary.classify({"actions": ["create", "update"]}), "update")
        self.assertEqual(summary.classify({"actions": ["no-op"], "importing": {"id": "x"}}), "import")

    def test_addresses(self):
        for address in ("a.b", 'module.x.cloudflare_r2_bucket.app["mail-hero-store"]', "a.b[0]", "data.x.y"):
            self.assertEqual(summary.safe_address(address), address)
        for address in ('a.b["x y"]', 'a.b["a@b"]', "a b", "", None, 3, "a." * 200 + "b", 'a.b["x"]\n| x |'):
            self.assertEqual(summary.safe_address(address), summary.WITHHELD)


if __name__ == "__main__":
    unittest.main()
