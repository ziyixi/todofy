"""Tests for infra/scripts/local_tfvars.py (no network): python3 -m unittest discover -s infra/tests"""

import contextlib
import importlib.util
import io
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "local_tfvars.py"
spec = importlib.util.spec_from_file_location("local_tfvars", SCRIPT)
local_tfvars = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_tfvars)

ACCOUNT = "0" * 31 + "a"
# Built at runtime so the "no email under infra/" guards (tests and CI) stay strict for committed text.
AT = "@"
EMAIL, OTHER = f"sentinel-a{AT}example.invalid", f"sentinel-b{AT}example.invalid"
IDP, GITHUB = "idp-sentinel-1", "idp-sentinel-2"


def fake(path):
    if path.endswith(local_tfvars.OWNER_POLICY):
        return {"include": [{"email": {"email": EMAIL}}]}
    if path.endswith(local_tfvars.GITHUB_OWNER_POLICY):
        return {"include": [{"email": {"email": OTHER}}], "require": [{"login_method": {"id": GITHUB}}]}
    if path.endswith(local_tfvars.MAIL_HERO_APP):
        return {"allowed_idps": [IDP, GITHUB]}
    raise AssertionError(path)


class LocalTfvars(unittest.TestCase):
    def test_values_match_the_variables(self):
        result = local_tfvars.values(ACCOUNT, fake)
        self.assertEqual(
            result,
            {
                "account_id": ACCOUNT,
                "access_owner_emails": [EMAIL],
                "access_github_owner_emails": [OTHER],
                "access_allowed_idp_ids": sorted([IDP, GITHUB]),
                "access_github_idp_id": GITHUB,
            },
        )
        variables = (SCRIPT.parents[1] / "variables.tf").read_text()
        for name in result:
            self.assertIn(f'variable "{name}"', variables)
        self.assertIn(f'access_owner_emails = ["{EMAIL}"]\n', local_tfvars.render(result))

    def test_rules_it_does_not_understand_are_refused_without_values(self):
        def odd(path):
            answer = fake(path)
            if path.endswith(local_tfvars.OWNER_POLICY):
                answer["include"].append({"everyone": {}})
            return answer

        with self.assertRaises(local_tfvars.Refused) as caught:
            local_tfvars.values(ACCOUNT, odd)
        self.assertNotIn("sentinel", str(caught.exception))

    def test_refuses_paths_inside_the_repository(self):
        for path in (local_tfvars.REPO / "infra" / "local.tfvars", local_tfvars.REPO / "x.tfvars", local_tfvars.REPO):
            with self.subTest(path=path), self.assertRaises(local_tfvars.Refused):
                local_tfvars.check_output(path)

    def test_writes_owner_only_and_prints_no_value(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "nested" / "local.tfvars"
            stdout, stderr = io.StringIO(), io.StringIO()
            with mock.patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "token-sentinel"}), \
                    mock.patch.object(local_tfvars, "get", lambda token, path: fake(path)), \
                    contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = local_tfvars.main(["--account-id", ACCOUNT, "--out", str(out)])
            self.assertEqual(code, 0)
            self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o600)
            self.assertIn(EMAIL, out.read_text())
        for text in (stdout.getvalue(), stderr.getvalue()):
            for value in (EMAIL, OTHER, IDP, GITHUB, ACCOUNT, "token-sentinel"):
                self.assertNotIn(value, text)

    def test_without_a_token_nothing_is_fetched(self):
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=True), contextlib.redirect_stderr(stderr), \
                mock.patch.object(local_tfvars, "get", side_effect=AssertionError("fetched")):
            code = local_tfvars.main(["--account-id", ACCOUNT, "--out", "/nonexistent-dir/x.tfvars"])
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
