"""Actual Access rules remain checked despite the provider's import normalization defect."""

import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import flowday_policy_guard as guard
import infra_state

OWNER = "owner" + "@" + "example.invalid"
FOREIGN = "foreign" + "@" + "example.invalid"


class ActualPolicy(unittest.TestCase):
    def policy(self):
        return {"decision": "allow", "include": [{"email": {"email": OWNER}},
                {"login_method": {"id": "github-idp"}}], "require": [], "exclude": []}

    def test_exact_rules_ignore_api_order(self):
        policy = self.policy()
        self.assertTrue(guard.matches(policy, "flowday", [OWNER], "github-idp"))
        policy["include"].reverse()
        self.assertTrue(guard.matches(policy, "flowday", [OWNER], "github-idp"))

    def test_changed_identity_extra_rule_and_require_are_rejected(self):
        changes = [
            {"decision": "bypass"},
            {"include": [{"email": {"email": FOREIGN}}, {"login_method": {"id": "github-idp"}}]},
            {"include": [{"email": {"email": OWNER}}, {"login_method": {"id": "foreign-idp"}}]},
            {"include": [*self.policy()["include"], {"everyone": {}}]},
            {"require": [{"everyone": {}}]},
            {"exclude": [{"email": {"email": OWNER}}]},
        ]
        for change in changes:
            with self.subTest(fields=list(change)):
                self.assertFalse(guard.matches({**self.policy(), **change}, "flowday", [OWNER], "github-idp"))

    def test_bypass_is_exactly_everyone(self):
        self.assertTrue(guard.matches({"decision": "bypass", "include": [{"everyone": {}}]}, "flowday-bypass", [], "github-idp"))
        self.assertFalse(guard.matches({"decision": "bypass", "include": [{"everyone": {}}, {"email": {}}]}, "flowday-bypass", [], "github-idp"))

    def test_reads_only_selected_existing_policy_and_reports_fixed_code(self):
        values = {"account_id": "account", "access_owner_emails": [OWNER],
                  "access_github_idp_id": "github-idp"}
        address = guard.PREFIX + '["flowday"]'
        plan = {"planned_values": {"root_module": {"resources": [{"address": address, "values": {"id": "owned-policy"}}]}}}
        paths = []

        def fetch(path):
            paths.append(path)
            return self.policy()

        self.assertEqual(guard.verify(plan, values, fetch), [])
        self.assertEqual(paths, ["/accounts/account/access/policies/owned-policy"])
        self.assertEqual(guard.verify(plan, values, lambda _: {"decision": "bypass", "include": []}), ["FLOWDAY_INCLUDE_MISMATCH:flowday"])
        fresh = copy.deepcopy(plan)
        fresh["planned_values"]["root_module"]["resources"][0]["values"] = {}
        self.assertEqual(guard.verify(fresh, values, lambda _: self.fail("fresh create must not read a nonexistent policy")), [])

    def test_guard_failure_is_an_apply_output_problem(self):
        document = {"_flowday_include_errors": ["FLOWDAY_INCLUDE_MISMATCH:flowday"]}
        with patch.object(infra_state, "read_wrangler_configs", return_value={}), patch.object(infra_state, "output_problems", return_value=[]):
            self.assertEqual(infra_state.check_outputs(document, {}), document["_flowday_include_errors"])
        with patch.object(infra_state, "tomllib", None):
            self.assertEqual(infra_state.check_outputs(document, {}), document["_flowday_include_errors"])


if __name__ == "__main__":
    unittest.main()
