"""Tests for infra/scripts/infra_state.py and bootstrap_state.py (no network, no OpenTofu, no Cloudflare):
python3 -m unittest discover -s infra/tests

A fake `tofu` on PATH stands in for OpenTofu: it records its arguments and environment, prints sentinel values
to its own output (which must never reach ours), and answers `show -json` with a plan fixture whose attribute
values are sentinels too. The S3 calls and the Cloudflare verify endpoint are replaced in-process.
"""

import contextlib
import datetime
import hashlib
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import infra_state  # noqa: E402
import bootstrap_state  # noqa: E402

# Built at runtime so the "no email / no 32-hex id under infra/" guards stay strict for committed text.
AT = "@"
SENTINEL_EMAIL = f"sentinel-owner{AT}example.invalid"
SENTINEL_IDP = "idp-sentinel-" + "7" * 6
ACCOUNT = "0" * 31 + "a"
TOKEN = "sentinel-token-" + "x" * 30
TOKEN_ID = "1" * 31 + "b"
PASSPHRASE = "sentinel-passphrase-0123456789"
VALUES = {
    "account_id": ACCOUNT,
    "access_owner_emails": [SENTINEL_EMAIL],
    "access_github_owner_emails": [SENTINEL_EMAIL],
    "access_allowed_idp_ids": [SENTINEL_IDP],
    "access_github_idp_id": SENTINEL_IDP,
}
SECRETS = (SENTINEL_EMAIL, SENTINEL_IDP, ACCOUNT, TOKEN, TOKEN_ID, PASSPHRASE, hashlib.sha256(TOKEN.encode()).hexdigest())
ADDRESSES = [
    'cloudflare_zero_trust_access_policy.owner',
    'cloudflare_zero_trust_access_application.owner["mail-hero"]',
    'cloudflare_d1_database.app["todofy"]',
]


def change(actions, importing=False):
    result = {
        "actions": actions,
        "before": {"include": [{"email": {"email": SENTINEL_EMAIL}}], "account_id": ACCOUNT},
        "after": {"include": [{"email": {"email": SENTINEL_EMAIL}}], "allowed_idps": [SENTINEL_IDP]},
    }
    if importing:
        result["importing"] = {"id": f"{ACCOUNT}/policy"}
    return result


# Synthetic production configs and the planned outputs that match them (the outputs check reads both).
AUD = "a" * 64
CONFIGS = {
    "app/wrangler.toml": {"name": "app", "vars": {"ACCESS_AUDIENCE": AUD},
                          "d1_databases": [{"database_name": "app", "database_id": "db-id-1"}],
                          "r2_buckets": [{"bucket_name": "app-store"}]},
    "site/wrangler.toml": {"name": "site"},
}
OUTPUTS = {"access_aud": {"value": {"app": AUD, "app-backup": "b" * 64}},
           "d1_database_ids": {"value": {"app": "db-id-1"}},
           "r2_bucket_names": {"value": ["app-store"]}}


def resource_type(address: str) -> str:
    return address.split("[", 1)[0].rsplit(".", 1)[0]


def plan_at(rows, outputs=None, planned_outputs=None):
    """A `tofu show -json` plan from (address, actions, importing) rows."""
    return {
        "format_version": "1.2",
        "variables": {"state_passphrase": {"value": PASSPHRASE}, "account_id": {"value": ACCOUNT}},
        "resource_changes": [
            {"address": address, "mode": "managed", "type": resource_type(address), "change": change(actions, importing)}
            for address, actions, importing in rows
        ],
        "output_changes": outputs or {},
        "planned_values": {"outputs": OUTPUTS if planned_outputs is None else planned_outputs},
    }


def plan(*rows, outputs=None, planned_outputs=None):
    """A `tofu show -json` plan: one (actions, importing) pair per address."""
    return plan_at([(address, actions, importing) for address, (actions, importing) in zip(ADDRESSES * 10, rows)],
                   outputs, planned_outputs)


@contextlib.contextmanager
def synthetic_configs():
    with mock.patch.object(infra_state, "tomllib", object()), \
            mock.patch.object(infra_state, "read_wrangler_configs", lambda repo=None: CONFIGS):
        yield


FAKE_TOFU = textwrap.dedent('''\
    #!{python}
    """Fake tofu: records calls, prints sentinels, serves the plan fixture."""
    import json, os, sys
    args = sys.argv[1:]
    record = os.environ["FAKE_RECORD"]
    with open(record, "a") as handle:
        handle.write(json.dumps({{"args": args, "env": {{k: v for k, v in os.environ.items()
                                  if k.startswith(("TF_", "AWS_", "CLOUDFLARE_", "INFRA_"))}}}}) + "\\n")
    if args[:1] == ["version"]:
        print(json.dumps({{"terraform_version": os.environ.get("FAKE_VERSION", "1.12.6")}}))
        sys.exit(0)
    if args[:1] != ["show"]:
        print("raw output " + os.environ.get("TF_VAR_state_passphrase", "") + " " + {email!r})
    if args[:1] == ["init"]:
        sys.exit(int(os.environ.get("FAKE_INIT_EXIT", "0")))
    if args[:1] == ["plan"]:
        out = [a.split("=", 1)[1] for a in args if a.startswith("-out=")][0]
        with open(out, "w") as handle:
            handle.write("encrypted plan")
        if os.environ.get("FAKE_PLAN_ERROR"):
            print("Error: Invalid value for variable \\"x\\" " + {email!r} + " " + {account!r})
            sys.exit(1)
        name = os.path.basename(out).split(".")[0]
        sys.exit(int(os.environ.get("FAKE_PLAN_EXIT_" + name.upper(), os.environ.get("FAKE_PLAN_EXIT", "0"))))
    if args[:2] == ["show", "-json"]:
        name = os.path.basename(args[-1]).split(".")[0]
        fixture = os.environ.get("FAKE_PLAN_" + name.upper()) or os.environ["FAKE_PLAN"]
        sys.stdout.write(open(fixture).read())
        sys.exit(0)
    if args[:1] == ["apply"]:
        sys.exit(int(os.environ.get("FAKE_APPLY_EXIT", "0")))
    sys.exit(9)
''')


class FakeTofu:
    """A temp dir with the fake tofu on PATH, plan fixtures and the call record."""

    def __init__(self, root: Path):
        self.root = root
        bin_dir = root / "bin"
        bin_dir.mkdir()
        tofu = bin_dir / "tofu"
        tofu.write_text(FAKE_TOFU.format(python=sys.executable, email=SENTINEL_EMAIL, account=ACCOUNT))
        tofu.chmod(tofu.stat().st_mode | stat.S_IEXEC)
        self.record = root / "calls.jsonl"
        self.env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "FAKE_RECORD": str(self.record),
                    "HOME": str(root)}

    def fixture(self, name: str, document) -> str:
        path = self.root / f"{name}.json"
        path.write_text(json.dumps(document))
        return str(path)

    def calls(self):
        if not self.record.exists():
            return []
        return [json.loads(line) for line in self.record.read_text().splitlines()]


def existing_parent(root: Path) -> Path:
    """A pre-existing --work-dir with a file of its own and a non-private mode: a run must leave both alone."""
    parent = root / "work"
    parent.mkdir()
    (parent / "keep.txt").write_text("not ours")
    parent.chmod(0o755)
    return parent


def assert_parent_untouched(test: unittest.TestCase, parent: Path, keep_work_dir: bool = False) -> list:
    """The parent survived with its file and mode; returns the run's own directories left in it."""
    test.assertTrue(parent.is_dir(), "the --work-dir parent must never be removed")
    test.assertEqual((parent / "keep.txt").read_text(), "not ours")
    test.assertEqual(stat.S_IMODE(parent.stat().st_mode), 0o755, "the --work-dir parent must never be chmodded")
    children = sorted(p for p in parent.iterdir() if p.name != "keep.txt")
    if not keep_work_dir:
        test.assertEqual(children, [], "the run's own work directory is removed")
    return children


def fake_fetch(path):
    if path == f"/accounts/{ACCOUNT}/tokens/verify":
        return {"id": TOKEN_ID, "status": "active"}
    raise infra_state.Refused("Cloudflare API HTTP 401 for a GET")


class Inputs(unittest.TestCase):
    def test_passphrase_is_required_and_there_is_no_fallback(self):
        for env in ({}, {"INFRA_STATE_PASSPHRASE": ""}, {"TF_VAR_state_passphrase": ""}):
            with self.subTest(env=sorted(env)):
                with self.assertRaisesRegex(infra_state.Refused, "no unencrypted fallback"):
                    infra_state.passphrase(env)
        with self.assertRaisesRegex(infra_state.Refused, "at least 16"):
            infra_state.passphrase({"INFRA_STATE_PASSPHRASE": "short"})
        with self.assertRaisesRegex(infra_state.Refused, "differ"):
            infra_state.passphrase({"INFRA_STATE_PASSPHRASE": PASSPHRASE, "TF_VAR_state_passphrase": PASSPHRASE + "x"})
        self.assertEqual(infra_state.passphrase({"INFRA_STATE_PASSPHRASE": PASSPHRASE}), PASSPHRASE)
        self.assertEqual(infra_state.passphrase({"TF_VAR_state_passphrase": PASSPHRASE}), PASSPHRASE)

    def test_values_in_json_or_local_tfvars_format(self):
        self.assertEqual(infra_state.parse_values(json.dumps(VALUES)), VALUES)
        lines = "".join(f"{name} = {json.dumps(value)}\n" for name, value in VALUES.items())
        self.assertEqual(infra_state.parse_values("# written by local_tfvars.py\n" + lines), VALUES)

    def test_values_refusals_never_quote_a_value(self):
        cases = {
            "extra variable": dict(VALUES, state_passphrase=PASSPHRASE),
            "missing variable": {k: v for k, v in VALUES.items() if k != "access_owner_emails"},
            "bad account": dict(VALUES, account_id=SENTINEL_EMAIL),
            "empty list": dict(VALUES, access_owner_emails=[]),
        }
        for name, values in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(infra_state.Refused) as caught:
                    infra_state.parse_values(json.dumps(values))
                for secret in SECRETS:
                    self.assertNotIn(secret, str(caught.exception))
        with self.assertRaises(infra_state.Refused) as caught:
            infra_state.parse_values(f"account_id = {SENTINEL_EMAIL}\n")
        self.assertNotIn(SENTINEL_EMAIL, str(caught.exception))

    def test_values_json_writes_to_a_pipe_never_a_terminal(self):
        class Terminal(io.StringIO):
            def isatty(self):
                return True

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "local.tfvars"
            source.write_text("".join(f"{name} = {json.dumps(value)}\n" for name, value in VALUES.items()))
            args = mock.Mock(var_file=source)
            terminal = Terminal()
            with self.assertRaisesRegex(infra_state.Refused, "terminal"):
                infra_state.command_values_json(args, terminal)
            self.assertEqual(terminal.getvalue(), "")
            pipe = io.StringIO()
            self.assertEqual(infra_state.command_values_json(args, pipe), 0)
            self.assertEqual(json.loads(pipe.getvalue()), VALUES)

    def test_paths_inside_the_repository_are_refused(self):
        with self.assertRaisesRegex(infra_state.Refused, "inside the repository"):
            infra_state.outside_repo(infra_state.REPO / "infra" / "values.json")
        with self.assertRaisesRegex(infra_state.Refused, "inside the repository"):
            infra_state.new_work_dir(infra_state.REPO / "infra", {})


class WorkDirectory(unittest.TestCase):
    """--work-dir is only ever a parent: the run creates, and may remove, only its own new directory."""

    def test_a_new_private_directory_inside_an_existing_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = existing_parent(Path(directory))
            work = infra_state.new_work_dir(parent, {})
            self.assertEqual(work.parent, parent.resolve())
            self.assertEqual(stat.S_IMODE(work.stat().st_mode), 0o700)
            infra_state.require_fresh_private_dir(work)
            self.assertNotEqual(infra_state.new_work_dir(parent, {}), work)
            work.rmdir()
            assert_parent_untouched(self, parent, keep_work_dir=True)

    def test_a_missing_parent_is_created_private(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory) / "a" / "b"
            work = infra_state.new_work_dir(parent, {})
            self.assertEqual(work.parent, parent.resolve())
            self.assertEqual(stat.S_IMODE(parent.stat().st_mode) & 0o077, 0)

    def test_the_runner_temp_is_the_default_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            work = infra_state.new_work_dir(None, {"RUNNER_TEMP": directory})
            self.assertEqual(work.parent.resolve(), Path(directory).resolve())

    def test_session_refuses_a_directory_it_did_not_create(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parent = existing_parent(root)
            for path in (parent, root / "missing"):  # not empty and not private; missing
                with self.subTest(path=path.name):
                    with self.assertRaisesRegex(infra_state.Refused, "work directory"):
                        infra_state.require_fresh_private_dir(path)
            loose = root / "loose"
            loose.mkdir(mode=0o755)
            loose.chmod(0o755)
            with self.assertRaisesRegex(infra_state.Refused, "new private directory"):
                infra_state.require_fresh_private_dir(loose)
            self.assertEqual(stat.S_IMODE(loose.stat().st_mode), 0o755, "never chmodded")


class Credentials(unittest.TestCase):
    def test_derived_from_the_token(self):
        key_id, secret = infra_state.s3_credentials({"CLOUDFLARE_API_TOKEN": TOKEN}, ACCOUNT, fake_fetch)
        self.assertEqual(key_id, TOKEN_ID)
        self.assertEqual(secret, hashlib.sha256(TOKEN.encode()).hexdigest())

    def test_user_tokens_verify_under_user(self):
        def user_only(path):
            if path == "/user/tokens/verify":
                return {"id": TOKEN_ID, "status": "active"}
            raise infra_state.Refused("Cloudflare API HTTP 401 for a GET")
        self.assertEqual(infra_state.token_id(ACCOUNT, user_only), TOKEN_ID)

    def test_inactive_or_unverifiable_tokens_are_refused(self):
        with self.assertRaisesRegex(infra_state.Refused, "not active"):
            infra_state.token_id(ACCOUNT, lambda path: {"id": TOKEN_ID, "status": "disabled"})

        def nothing(path):
            raise infra_state.Refused("Cloudflare API HTTP 403 for a GET")
        with self.assertRaisesRegex(infra_state.Refused, "INFRA_R2_ACCESS_KEY_ID"):
            infra_state.token_id(ACCOUNT, nothing)

    def test_the_explicit_fallback_pair(self):
        env = {"INFRA_R2_ACCESS_KEY_ID": "key-id", "INFRA_R2_SECRET_ACCESS_KEY": "key-secret"}
        self.assertEqual(infra_state.s3_credentials(env, ACCOUNT, fake_fetch), ("key-id", "key-secret"))
        with self.assertRaisesRegex(infra_state.Refused, "both"):
            infra_state.s3_credentials({"INFRA_R2_ACCESS_KEY_ID": "key-id"}, ACCOUNT, fake_fetch)

    def test_masks_only_on_a_runner(self):
        out = io.StringIO()
        infra_state.mask(["value-1"], {"GITHUB_ACTIONS": "true"}, out)  # not a real runner: nothing printed
        self.assertEqual(out.getvalue(), "")
        runner = {"GITHUB_ACTIONS": "true", "GITHUB_RUN_ID": "1", "RUNNER_TEMP": "/tmp"}
        infra_state.mask(["value-1", "", "value-2", "value-1"], runner, out)
        self.assertEqual(out.getvalue(), "::add-mask::value-1\n::add-mask::value-2\n")

    def test_mask_escapes_command_data(self):
        out = io.StringIO()
        runner = {"GITHUB_ACTIONS": "true", "GITHUB_RUN_ID": "1", "RUNNER_TEMP": "/tmp"}
        infra_state.mask(["a%b\nc\rd"], runner, out)
        self.assertEqual(out.getvalue(), "::add-mask::a%25b%0Ac%0Dd\n")

    def test_value_scalars_cover_every_value(self):
        values = dict(VALUES, access_owner_emails=["one" + AT + "example.invalid", "two" + AT + "example.invalid"])
        scalars = infra_state.value_scalars(values)
        self.assertEqual(scalars, [ACCOUNT, "one" + AT + "example.invalid", "two" + AT + "example.invalid",
                                   SENTINEL_EMAIL, SENTINEL_IDP, SENTINEL_IDP])

    def test_sigv4_signs_path_style_requests_deterministically(self):
        now = datetime.datetime(2026, 10, 1, tzinfo=datetime.timezone.utc)
        url = "https://example.invalid/infra-state/production/terraform.tfstate"
        first = infra_state.sigv4_headers("GET", url, ("key-id", "key-secret"), now=now)
        self.assertEqual(first, infra_state.sigv4_headers("GET", url, ("key-id", "key-secret"), now=now))
        self.assertTrue(first["authorization"].startswith("AWS4-HMAC-SHA256 Credential=key-id/20261001/auto/s3/aws4_request, "))
        self.assertNotIn("key-secret", json.dumps(first))
        other = infra_state.sigv4_headers("GET", url, ("key-id", "other-secret"), now=now)
        self.assertNotEqual(first["authorization"], other["authorization"])

    def test_encrypted_state_detection(self):
        encrypted = {"serial": 1, "lineage": "l", "meta": {"key_provider.pbkdf2.state": "x"}, "encrypted_data": "x",
                     "encryption_version": "v0"}
        self.assertTrue(infra_state.encrypted_state(json.dumps(encrypted).encode()))
        self.assertFalse(infra_state.encrypted_state(json.dumps({"version": 4, "resources": []}).encode()))
        self.assertFalse(infra_state.encrypted_state(b"not json"))


class ChildEnvironment(unittest.TestCase):
    def test_strips_everything_that_could_print_or_redirect(self):
        base = {
            "PATH": "/bin", "HOME": "/home/x", "TF_PLUGIN_CACHE_DIR": "/cache",
            "TF_LOG": "TRACE", "TF_LOG_PATH": "/tmp/log", "TF_ENCRYPTION": "fallback", "TF_CLI_ARGS_plan": "-x",
            "TF_VAR_access_owner_emails": "[]", "TF_WORKSPACE": "other", "AWS_PROFILE": "p", "AWS_ENDPOINT_URL": "u",
            "INFRA_STATE_PASSPHRASE": PASSPHRASE, "INFRA_TFVARS": "{}", "INFRA_R2_SECRET_ACCESS_KEY": "s",
        }
        env = infra_state.child_env(base, token=TOKEN, passphrase_value=PASSPHRASE, credentials=("k", "s"),
                                    s3_endpoint="https://example.invalid", data_dir=Path("/data"))
        for name in ("TF_LOG", "TF_LOG_PATH", "TF_ENCRYPTION", "TF_CLI_ARGS_plan", "TF_VAR_access_owner_emails",
                     "TF_WORKSPACE", "AWS_PROFILE", "AWS_ENDPOINT_URL", "INFRA_STATE_PASSPHRASE", "INFRA_TFVARS",
                     "INFRA_R2_SECRET_ACCESS_KEY"):
            with self.subTest(name=name):
                self.assertNotIn(name, env)
        self.assertEqual(env["PATH"], "/bin")
        self.assertEqual(env["TF_PLUGIN_CACHE_DIR"], "/cache")
        self.assertEqual(env["TF_VAR_state_passphrase"], PASSPHRASE)
        self.assertEqual((env["AWS_ACCESS_KEY_ID"], env["AWS_SECRET_ACCESS_KEY"]), ("k", "s"))
        self.assertEqual(env["AWS_ENDPOINT_URL_S3"], "https://example.invalid")
        self.assertEqual(env["TF_INPUT"], "0")

    def test_error_headlines_are_sanitised(self):
        log = "\n".join([
            "Initializing...",
            f"│ Error: Invalid value for variable \"emails\" {SENTINEL_EMAIL}",
            f"Error: failed to read https://{ACCOUNT}.r2.cloudflarestorage.com/infra-state with {TOKEN}",
            f"Error: decryption failed: '{PASSPHRASE}'",
            f"  some detail {SENTINEL_EMAIL}",
        ])
        lines = infra_state.error_headlines(log)
        self.assertEqual(len(lines), 3)
        self.assertTrue(all(line.startswith("Error: ") for line in lines))
        for secret in SECRETS:
            self.assertNotIn(secret, "\n".join(lines))


class Verdicts(unittest.TestCase):
    def summary(self, document):
        return infra_state.summarize(document)[0]

    def test_drift_exit_codes(self):
        self.assertEqual(infra_state.drift_exit(self.summary(plan((["no-op"], False)) )), 0)
        self.assertEqual(infra_state.drift_exit(self.summary(plan((["update"], False)))), 2)
        self.assertEqual(infra_state.drift_exit(self.summary(plan((["no-op"], True)))), 2)  # an import is an action
        self.assertEqual(infra_state.drift_exit(self.summary(plan((["create"], False)))), 2)
        self.assertEqual(infra_state.drift_exit(self.summary(plan((["no-op"], False), outputs={"x": {"actions": ["create"]}}))), 2)
        for actions in (["delete"], ["delete", "create"], ["create", "delete"], ["forget"]):
            with self.subTest(actions=actions):
                self.assertEqual(infra_state.drift_exit(self.summary(plan((["no-op"], False), (actions, False)))), 3)

    def test_import_only_decision(self):
        decide = bootstrap_state.import_decision
        self.assertEqual(decide(self.summary(plan(*[(["no-op"], True)] * 3)), 3), "apply")
        self.assertEqual(decide(self.summary(plan((["no-op"], True), (["no-op"], False), (["no-op"], True))), 3), "apply")
        self.assertEqual(decide(self.summary(plan(*[(["no-op"], False)] * 3)), 3), "done")
        # A new state has no outputs yet: creating them is part of the import-only apply.
        with_outputs = plan(*[(["no-op"], True)] * 3, outputs={"x": {"actions": ["create"]}})
        self.assertEqual(decide(self.summary(with_outputs), 3), "apply")
        outputs_only = plan(*[(["no-op"], False)] * 3, outputs={"x": {"actions": ["create"]}})
        self.assertEqual(decide(self.summary(outputs_only), 3), "apply")
        refused = {
            "import+update": plan((["no-op"], True), (["update"], True), (["no-op"], True)),
            "create": plan((["no-op"], True), (["no-op"], True), (["create"], False)),
            "update": plan((["no-op"], True), (["no-op"], True), (["update"], False)),
            "replace": plan((["no-op"], True), (["no-op"], True), (["delete", "create"], False)),
            "delete": plan((["no-op"], True), (["no-op"], True), (["delete"], False)),
            "forget": plan((["no-op"], True), (["no-op"], True), (["forget"], False)),
            "too few": plan((["no-op"], True), (["no-op"], True)),
            "output update": plan(*[(["no-op"], True)] * 3, outputs={"x": {"actions": ["update"]}}),
            "output delete": plan(*[(["no-op"], True)] * 3, outputs={"x": {"actions": ["delete"]}}),
        }
        for name, document in refused.items():
            with self.subTest(case=name):
                with self.assertRaises(bootstrap_state.NotImportOnly) as caught:
                    decide(self.summary(document), 3)
                for secret in SECRETS:
                    self.assertNotIn(secret, str(caught.exception))

    def test_final_check(self):
        bootstrap_state.final_check(0, self.summary(plan(*[(["no-op"], False)] * 3)), 3)
        with self.assertRaises(infra_state.Refused):
            bootstrap_state.final_check(2, self.summary(plan(*[(["no-op"], False)] * 3)), 3)
        with self.assertRaises(infra_state.Refused):
            bootstrap_state.final_check(0, self.summary(plan((["no-op"], False), (["update"], False), (["no-op"], False))), 3)


class PlanCommand(unittest.TestCase):
    """infra_state.py plan as CI runs it: only the summary reaches stdout, and the exit code is the verdict."""

    def run_plan(self, document, plan_exit=0, extra_env=None):
        with tempfile.TemporaryDirectory() as directory:
            fake = FakeTofu(Path(directory))
            env = dict(fake.env, CLOUDFLARE_API_TOKEN=TOKEN, INFRA_STATE_PASSPHRASE=PASSPHRASE,
                       INFRA_TFVARS=json.dumps(VALUES), FAKE_PLAN=fake.fixture("plan", document),
                       FAKE_PLAN_EXIT=str(plan_exit), TF_LOG="TRACE", TF_ENCRYPTION="x")
            env.update(extra_env or {})
            parent = existing_parent(Path(directory))
            out, err = io.StringIO(), io.StringIO()
            with mock.patch.dict(os.environ, env, clear=True), synthetic_configs(), \
                    mock.patch.object(infra_state, "cloudflare_get", lambda token, path: fake_fetch(path)), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = infra_state.main(["plan", "--work-dir", str(parent)])
            # The run's own directory (values, plan, log) is removed; the given parent and its file are not.
            assert_parent_untouched(self, parent)
            return code, out.getvalue(), err.getvalue(), fake.calls()

    def assert_clean(self, text):
        for secret in SECRETS + ("raw output",):
            self.assertNotIn(secret, text)

    def test_no_changes(self):
        code, out, err, calls = self.run_plan(plan(*[(["no-op"], False)] * 3))
        self.assertEqual(code, 0)
        self.assertIn("no-op: 3", out)
        self.assert_clean(out + err)
        init, plan_call, show = calls
        self.assertEqual(init["args"][0], "init")
        self.assertIn("-backend-config=key=production/terraform.tfstate", init["args"])
        self.assertIn("-detailed-exitcode", plan_call["args"])
        self.assertEqual(show["args"][:2], ["show", "-json"])
        environment = plan_call["env"]
        self.assertEqual(environment["TF_VAR_state_passphrase"], PASSPHRASE)
        self.assertEqual(environment["AWS_ACCESS_KEY_ID"], TOKEN_ID)
        self.assertEqual(environment["AWS_SECRET_ACCESS_KEY"], hashlib.sha256(TOKEN.encode()).hexdigest())
        self.assertEqual(environment["AWS_ENDPOINT_URL_S3"], f"https://{ACCOUNT}.r2.cloudflarestorage.com")
        self.assertNotIn("TF_LOG", environment)
        self.assertNotIn("TF_ENCRYPTION", environment)
        self.assertNotIn("INFRA_TFVARS", environment)

    def test_drift_and_destroy(self):
        code, out, err, _ = self.run_plan(plan((["update"], False), (["no-op"], False)), plan_exit=2)
        self.assertEqual(code, 2)
        self.assertIn("update: 1", out)
        self.assertIn('"Infra apply" expect for this plan: update=1', out)
        self.assertIn('`cloudflare_zero_trust_access_policy.owner`', out)
        self.assert_clean(out + err)
        code, out, err, _ = self.run_plan(plan((["delete", "create"], False)), plan_exit=2)
        self.assertEqual(code, 3)
        self.assert_clean(out + err)

    def test_outputs_that_differ_from_the_configs_fail_with_names_only(self):
        changed = dict(OUTPUTS, access_aud={"value": {"app": "c" * 64}})
        code, out, err, _ = self.run_plan(plan((["no-op"], False), planned_outputs=changed))
        self.assertEqual(code, 5)
        self.assertIn("app/wrangler.toml: vars.ACCESS_AUDIENCE differs from access_aud", err)
        self.assertNotIn("c" * 64, out + err)
        self.assertNotIn(AUD, out + err)
        self.assert_clean(out + err)
        # A delete or replace still wins: exit 3.
        code, _, _, _ = self.run_plan(plan((["delete"], False), planned_outputs=changed), plan_exit=2)
        self.assertEqual(code, 3)

    def test_keep_work_dir_keeps_the_log_but_never_the_values_or_the_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = FakeTofu(Path(directory))
            env = dict(fake.env, CLOUDFLARE_API_TOKEN=TOKEN, INFRA_STATE_PASSPHRASE=PASSPHRASE,
                       INFRA_TFVARS=json.dumps(VALUES), FAKE_PLAN=fake.fixture("plan", plan((["no-op"], False))))
            parent = existing_parent(Path(directory))
            with mock.patch.dict(os.environ, env, clear=True), synthetic_configs(), \
                    mock.patch.object(infra_state, "cloudflare_get", lambda token, path: fake_fetch(path)), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(infra_state.main(["plan", "--work-dir", str(parent), "--keep-work-dir"]), 0)
            [run] = assert_parent_untouched(self, parent, keep_work_dir=True)
            self.assertEqual(sorted(p.name for p in run.iterdir() if p.is_file()), ["tofu.log"])

    def test_an_unclassified_tofu_change_is_never_clean(self):
        code, _, _, _ = self.run_plan(plan((["no-op"], False)), plan_exit=2)
        self.assertEqual(code, 2)

    def test_tofu_errors_print_sanitised_headlines_only(self):
        code, out, err, _ = self.run_plan(plan((["no-op"], False)), extra_env={"FAKE_PLAN_ERROR": "1"})
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("tofu plan failed", err)
        self.assertIn("Error: Invalid value for variable", err)
        self.assert_clean(out + err)

    def test_refuses_before_tofu_without_the_passphrase(self):
        code, out, err, calls = self.run_plan(plan((["no-op"], False)), extra_env={"INFRA_STATE_PASSPHRASE": ""})
        self.assertEqual(code, 1)
        self.assertIn("no unencrypted fallback", err)
        self.assertEqual(calls, [])

    def test_a_refused_run_leaves_an_existing_work_dir_parent_alone(self):
        # The review's reproduction: no passphrase, --work-dir an existing directory. run_plan asserts that the
        # directory, its file and its mode survive; here also with tofu failing after the work dir exists.
        for extra in ({"INFRA_STATE_PASSPHRASE": ""}, {"FAKE_INIT_EXIT": "1"}, {"CLOUDFLARE_API_TOKEN": ""}):
            with self.subTest(case=sorted(extra)):
                code, _, _, _ = self.run_plan(plan((["no-op"], False)), extra_env=extra)
                self.assertEqual(code, 1)

    def test_masks_every_value_and_the_derived_credentials_on_a_runner(self):
        runner = {"GITHUB_ACTIONS": "true", "GITHUB_RUN_ID": "1", "RUNNER_TEMP": tempfile.gettempdir()}
        code, out, err, _ = self.run_plan(plan((["no-op"], False)), extra_env=runner)
        self.assertEqual(code, 0)
        masks = [line for line in out.splitlines() if line.startswith("::add-mask::")]
        # Every scalar inside INFRA_TFVARS (GitHub masks only the whole JSON string), then the derived pair.
        self.assertEqual(masks, [f"::add-mask::{value}" for value in (
            ACCOUNT, SENTINEL_EMAIL, SENTINEL_IDP, TOKEN_ID, hashlib.sha256(TOKEN.encode()).hexdigest())])
        self.assertTrue(out.startswith("\n".join(masks) + "\n"), "masks are registered before anything else is printed")
        rest = "\n".join(line for line in out.splitlines() if not line.startswith("::add-mask::"))
        self.assert_clean(rest + err)


class Outputs(unittest.TestCase):
    """The planned outputs against the apps' wrangler.toml files: field names and paths only, never a value."""

    def test_matching_outputs_have_no_problem(self):
        self.assertEqual(infra_state.output_problems(infra_state.planned_outputs(plan()), CONFIGS), [])

    def test_every_kind_of_difference_is_named(self):
        cases = {
            "aud": (dict(OUTPUTS, access_aud={"value": {}}), "vars.ACCESS_AUDIENCE differs"),
            "d1": (dict(OUTPUTS, d1_database_ids={"value": {"app": "db-id-2"}}), "database_id differs"),
            "r2": (dict(OUTPUTS, r2_bucket_names={"value": []}), "bucket_name is not in r2_bucket_names"),
            "missing": ({k: v for k, v in OUTPUTS.items() if k != "access_aud"}, "no output access_aud"),
            "unknown": (dict(OUTPUTS, access_aud={"value": None}), "not known before the apply"),
        }
        for name, (outputs, needle) in cases.items():
            with self.subTest(case=name):
                problems = infra_state.output_problems(infra_state.planned_outputs(plan(planned_outputs=outputs)), CONFIGS)
                self.assertTrue(any(needle in problem for problem in problems), problems)
                for value in (AUD, "db-id-1", "db-id-2"):
                    self.assertNotIn(value, "\n".join(problems))

    def test_without_tomllib_the_check_is_skipped_locally_and_refused_on_a_runner(self):
        with mock.patch.object(infra_state, "tomllib", None):
            with contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(infra_state.check_outputs(plan(), {}), [])
            self.assertIn("skipped", err.getvalue())
            runner = {"GITHUB_ACTIONS": "true", "GITHUB_RUN_ID": "1", "RUNNER_TEMP": "/tmp"}
            with self.assertRaisesRegex(infra_state.Refused, "3.11"):
                infra_state.check_outputs(plan(), runner)

    @unittest.skipIf(infra_state.tomllib is None, "needs Python 3.11+ (tomllib)")
    def test_the_real_production_configs_parse(self):
        configs = infra_state.read_wrangler_configs()
        self.assertEqual(sorted(configs), sorted(infra_state.WRANGLER_CONFIGS))
        self.assertTrue(all(config.get("name") for config in configs.values()))


class ApplyGates(unittest.TestCase):
    def summary(self, document):
        return infra_state.summarize(document)[0]

    def test_expect_is_parsed_strictly_and_round_trips(self):
        self.assertEqual(infra_state.parse_expect("import=5,outputs=3"), {"import": 5, "outputs": 3})
        self.assertEqual(infra_state.parse_expect(" update=1  import+update=2 create=0 "), {"update": 1, "import+update": 2})
        self.assertEqual(infra_state.parse_expect("none"), {})
        for text in ("", "   ", "import", "import=x", "import=1,import=2", "destroy=1", "import=5;outputs=3"):
            with self.subTest(text=text):
                with self.assertRaises(infra_state.Refused):
                    infra_state.parse_expect(text)
        for found in ({}, {"import": 5, "outputs": 3}, {"import+update": 1, "update": 2}):
            with self.subTest(found=found):
                self.assertEqual(infra_state.parse_expect(infra_state.format_expect(found)), found)

    def test_plan_counts(self):
        document = plan((["no-op"], True), (["update"], True), (["no-op"], False),
                        outputs={"x": {"actions": ["create"]}, "y": {"actions": ["no-op"]}})
        self.assertEqual(infra_state.plan_counts(self.summary(document)), {"import": 1, "import+update": 1, "outputs": 1})

    def test_types_outside_the_allowlist_and_data_sources(self):
        document = plan_at([
            ('cloudflare_dns_record.x', ["create"], False),
            ('cloudflare_r2_bucket.app["a"]', ["update"], False),
            ('cloudflare_workers_script.y', ["no-op"], False),  # no action: not reported
        ])
        document["resource_changes"].append({"address": "data.cloudflare_zone.z", "mode": "data", "type": "cloudflare_zone",
                                             "change": change(["read"])})
        self.assertEqual(infra_state.type_violations(document), ["a cloudflare_zone data source", "cloudflare_dns_record"])
        document["resource_changes"][0]["type"] = f"weird {SENTINEL_EMAIL}"
        self.assertNotIn(SENTINEL_EMAIL, "".join(infra_state.type_violations(document)))

    def test_frozen_objects_may_be_imported_but_never_written(self):
        backup = "cloudflare_zero_trust_access_application.mail_hero_backup"
        for actions, importing, frozen in ((["no-op"], False, []), (["no-op"], True, []), (["update"], False, [backup]),
                                           (["update"], True, [backup]), (["delete", "create"], False, [backup])):
            with self.subTest(actions=actions, importing=importing):
                summary = self.summary(plan_at([(backup, actions, importing)]))
                self.assertEqual(infra_state.frozen_violations(summary), frozen)

    def gate(self, document, expected, allow=False, problems=()):
        infra_state.apply_gate(self.summary(document), document, expected, allow, list(problems))

    def test_the_gate_passes_exactly_the_expected_plan(self):
        imports = plan(*[(["no-op"], True)] * 2, outputs={"x": {"actions": ["create"]}})
        self.gate(imports, {"import": 2, "outputs": 1})
        refusals = {
            "other counts": (imports, {"import": 3, "outputs": 1}, False, (), "not the expected"),
            "missing outputs": (imports, {"import": 2}, False, (), "not the expected"),
            "destructive": (plan((["delete"], False)), {"delete": 1}, False, (), "deletes, replaces or forgets"),
            "outputs differ": (imports, {"import": 2, "outputs": 1}, False, ("x",), "wrangler.toml"),
            "type": (plan_at([("cloudflare_dns_record.x", ["create"], False)]), {"create": 1}, False, (), "ALLOWED_TYPES"),
            "frozen": (plan_at([("cloudflare_zero_trust_access_application.mail_hero_backup", ["update"], False)]),
                       {"update": 1}, False, (), "FROZEN"),
        }
        for name, (document, expected, allow, problems, needle) in refusals.items():
            with self.subTest(case=name):
                with self.assertRaisesRegex(infra_state.Refused, needle) as caught:
                    self.gate(document, expected, allow, problems)
                self.assertEqual(isinstance(caught.exception, infra_state.Destructive), name == "destructive")
                for secret in SECRETS:
                    self.assertNotIn(secret, str(caught.exception))

    def test_a_confirmed_dispatch_lifts_only_the_destructive_gate(self):
        replace = plan((["delete", "create"], False))
        self.gate(replace, {"replace": 1}, allow=True)
        with self.assertRaisesRegex(infra_state.Refused, "not the expected"):
            self.gate(replace, {"update": 1}, allow=True)
        with self.assertRaisesRegex(infra_state.Refused, "FROZEN"):
            self.gate(plan_at([("cloudflare_zero_trust_access_application.mail_hero_backup", ["delete"], False)]),
                      {"delete": 1}, allow=True)


ENCRYPTED_STATE = json.dumps({"serial": 7, "lineage": "l", "meta": {"key_provider.pbkdf2.state": "salt"},
                              "encrypted_data": "x", "encryption_version": "v0"}).encode()


class ApplyCommand(unittest.TestCase):
    """infra_state.py apply as "Infra apply" runs it, with a fake tofu and an in-memory state bucket."""

    def run_apply(self, first, verify=None, expect="import=2,outputs=1", extra_env=None, bucket=None, first_exit=2):
        bucket = {"production/terraform.tfstate": ENCRYPTED_STATE} if bucket is None else bucket
        with tempfile.TemporaryDirectory() as directory:
            fake = FakeTofu(Path(directory))
            env = dict(fake.env, CLOUDFLARE_API_TOKEN=TOKEN, INFRA_STATE_PASSPHRASE=PASSPHRASE,
                       INFRA_TFVARS=json.dumps(VALUES), INFRA_APPLY_EXPECT=expect,
                       FAKE_PLAN_APPLY=fake.fixture("apply", first),
                       FAKE_PLAN_VERIFY=fake.fixture("verify", verify or plan(*[(["no-op"], False)] * 2)),
                       FAKE_PLAN_EXIT_APPLY=str(first_exit), FAKE_PLAN_EXIT_VERIFY="0")
            env.update(extra_env or {})
            requests = []

            def s3(method, base, path, credentials, payload=b"", extra=None):
                key = path.split("/", 1)[1]
                requests.append((method, key, dict(extra or {})))
                if method == "PUT":
                    if (extra or {}).get("If-None-Match") == "*" and key in bucket:
                        return 412, b""
                    bucket[key] = payload
                    return 200, b""
                return (200, bucket[key]) if key in bucket else (404, b"")

            parent = existing_parent(Path(directory))
            out, err = io.StringIO(), io.StringIO()
            with mock.patch.dict(os.environ, env, clear=True), synthetic_configs(), \
                    mock.patch.object(infra_state, "cloudflare_get", lambda token, path: fake_fetch(path)), \
                    mock.patch.object(infra_state, "s3_request", s3), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = infra_state.main(["apply", "--work-dir", str(parent)])
            assert_parent_untouched(self, parent)
            return code, out.getvalue(), err.getvalue(), fake.calls(), bucket, requests

    def assert_clean(self, text):
        for secret in SECRETS + ("raw output",):
            self.assertNotIn(secret, text)

    def imports(self):
        return plan(*[(["no-op"], True)] * 2, outputs={"x": {"actions": ["create"]}})

    def test_backs_up_gates_applies_the_saved_plan_and_verifies(self):
        code, out, err, calls, bucket, requests = self.run_apply(self.imports(), extra_env={"GITHUB_RUN_ID": "42"})
        self.assertEqual(code, 0, err)
        self.assertEqual([c["args"][0] for c in calls], ["init", "plan", "show", "apply", "plan", "show"])
        self.assertEqual(calls[3]["args"][-1].rsplit("/", 1)[-1], "apply.tfplan")
        [backup] = [key for key in bucket if key.startswith("backups/")]
        self.assertRegex(backup, r"^backups/production/terraform\.tfstate\.\d{8}T\d{6}Z-run42$")
        self.assertEqual(bucket[backup], ENCRYPTED_STATE)
        # The copy is written before tofu starts, never over an existing key, and read back.
        self.assertEqual([r[:2] for r in requests],
                         [("GET", "production/terraform.tfstate"), ("HEAD", backup), ("PUT", backup), ("GET", backup)])
        self.assertIn("every gate passed", out)
        self.assertIn('apply: done', out)
        self.assert_clean(out + err)

    def test_refusals_never_apply(self):
        cases = {
            "other counts": dict(expect="import=3,outputs=1"),
            "no expect": dict(expect=""),
            "bad confirm": dict(extra_env={"INFRA_CONFIRM_DESTRUCTIVE": "yes"}),
            "outputs differ": dict(first=plan(*[(["no-op"], True)] * 2, outputs={"x": {"actions": ["create"]}},
                                              planned_outputs=dict(OUTPUTS, d1_database_ids={"value": {}}))),
            "unencrypted state": dict(bucket={"production/terraform.tfstate": b'{"version": 4, "resources": []}'}),
            "no state": dict(bucket={}),
        }
        taken = {"production/terraform.tfstate": ENCRYPTED_STATE,
                 "backups/production/terraform.tfstate.20261001T120000Z-run7": b"older"}
        cases["backup key taken"] = dict(bucket=taken, extra_env={"GITHUB_RUN_ID": "7"})
        noon = datetime.datetime(2026, 10, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)
        with mock.patch.object(infra_state, "utc_now", lambda: noon):
            self.check_refusals(cases)
        self.assertEqual(taken["backups/production/terraform.tfstate.20261001T120000Z-run7"], b"older")

    def check_refusals(self, cases):
        for name, options in cases.items():
            with self.subTest(case=name):
                first = options.pop("first", self.imports())
                code, out, err, calls, bucket, _ = self.run_apply(first, **options)
                self.assertEqual(code, 1)
                self.assertFalse([c for c in calls if c["args"][:1] == ["apply"]])
                self.assert_clean(out + err)
                if name in ("unencrypted state", "no state", "no expect", "bad confirm"):
                    self.assertFalse([key for key in bucket if key.startswith("backups/")])
                if name in ("unencrypted state", "no state", "no expect", "bad confirm", "backup key taken"):
                    self.assertEqual(calls, [])

    def test_a_destructive_plan_needs_the_confirmation(self):
        replace = plan((["delete", "create"], False))
        code, out, err, calls, _, _ = self.run_apply(replace, expect="replace=1")
        self.assertEqual(code, 3)
        self.assertIn("delete-replace-forget", err)
        self.assertFalse([c for c in calls if c["args"][:1] == ["apply"]])
        code, out, err, calls, _, _ = self.run_apply(replace, expect="replace=1",
                                                     extra_env={"INFRA_CONFIRM_DESTRUCTIVE": "delete-replace-forget"})
        self.assertEqual(code, 0, err)
        self.assertEqual(len([c for c in calls if c["args"][:1] == ["apply"]]), 1)

    def test_nothing_to_apply(self):
        code, out, err, calls, _, _ = self.run_apply(plan(*[(["no-op"], False)] * 2), expect="none", first_exit=0)
        self.assertEqual(code, 0, err)
        self.assertIn("nothing to apply", out)
        self.assertFalse([c for c in calls if c["args"][:1] == ["apply"]])

    def test_an_unclassified_tofu_change_is_never_applied(self):
        code, _, err, calls, _, _ = self.run_apply(plan(*[(["no-op"], False)] * 2), expect="none", first_exit=2)
        self.assertEqual(code, 1)
        self.assertIn("does not classify", err)
        self.assertFalse([c for c in calls if c["args"][:1] == ["apply"]])

    def test_a_verify_plan_with_changes_fails_after_the_apply(self):
        code, out, err, calls, _, _ = self.run_apply(self.imports(), verify=plan((["update"], False), (["no-op"], False)))
        self.assertEqual(code, 1)
        self.assertIn("not \"No changes\"", err)
        self.assertEqual(len([c for c in calls if c["args"][:1] == ["apply"]]), 1)

    def test_masks_every_value_on_a_runner(self):
        runner = {"GITHUB_ACTIONS": "true", "GITHUB_RUN_ID": "1", "RUNNER_TEMP": tempfile.gettempdir()}
        code, out, err, _, _, _ = self.run_apply(self.imports(), extra_env=runner)
        self.assertEqual(code, 0, err)
        self.assertTrue(out.startswith("::add-mask::"))
        rest = "\n".join(line for line in out.splitlines() if not line.startswith("::add-mask::"))
        self.assert_clean(rest + err)


class Rotation(unittest.TestCase):
    def test_helpers(self):
        self.assertEqual(infra_state.committed_key_provider(), "state")
        with tempfile.TemporaryDirectory() as directory:
            versions = Path(directory) / "versions.tf"
            versions.write_text('key_provider "pbkdf2" "a" {}\nkey_provider "pbkdf2" "b" {}\n')
            with self.assertRaises(infra_state.Refused):
                infra_state.committed_key_provider(versions)
        body = json.dumps({"meta": {"key_provider.pbkdf2.state": "salt"}, "encrypted_data": "x"}).encode()
        self.assertEqual(infra_state.state_key_providers(body), ["state"])
        self.assertEqual(infra_state.hcl_string('a"b\\c${x}%{y}'), '"a\\"b\\\\c$${x}%%{y}"')
        with self.assertRaises(infra_state.Refused):
            infra_state.hcl_string("a\nb")
        text = infra_state.fallback_encryption("state", PASSPHRASE)
        self.assertIn('key_provider "pbkdf2" "state" {', text)
        self.assertEqual(text.count("fallback {"), 2)
        self.assertEqual(text.count("method   = method.aes_gcm.state"), 2)  # writes use the committed method only

    def run_rotate(self, written_with, after):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = FakeTofu(root)
            old = root / "old"
            old.write_text("old-passphrase-0123456789\n")
            old.chmod(0o600)
            values = root / "values.json"
            values.write_text(json.dumps(VALUES))
            env = dict(fake.env, CLOUDFLARE_API_TOKEN=TOKEN, INFRA_STATE_PASSPHRASE=PASSPHRASE,
                       FAKE_PLAN=fake.fixture("plan", plan(*[(["no-op"], False)] * 3)))

            def s3(method, base, path, credentials, payload=b"", extra=None):
                refreshed = any("-refresh-only" in call["args"] for call in fake.calls())
                name = after if refreshed else written_with
                return 200, json.dumps({"meta": {f"key_provider.pbkdf2.{name}": "s"}, "encrypted_data": "x"}).encode()

            parent = existing_parent(root)
            out, err = io.StringIO(), io.StringIO()
            with mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(infra_state, "cloudflare_get", lambda token, path: fake_fetch(path)), \
                    mock.patch.object(infra_state, "s3_request", s3), \
                    mock.patch.object(infra_state, "committed_key_provider", lambda: "state_2"), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = infra_state.main(["rotate-passphrase", "--var-file", str(values), "--old-passphrase-file", str(old),
                                         "--work-dir", str(parent)])
            assert_parent_untouched(self, parent)
            return code, out.getvalue(), err.getvalue(), fake.calls()

    def test_rotation_reencrypts_then_plans_with_the_new_passphrase_alone(self):
        code, out, err, calls = self.run_rotate("state", "state_2")
        self.assertEqual(code, 0, err)
        self.assertEqual([c["args"][0] for c in calls], ["init", "apply", "init", "plan", "show"])
        rotating, final = calls[:2], calls[2:]
        for call in rotating:
            self.assertIn('key_provider "pbkdf2" "state"', call["env"]["TF_ENCRYPTION"])
            self.assertIn("old-passphrase-0123456789", call["env"]["TF_ENCRYPTION"])
            self.assertEqual(call["env"]["TF_VAR_state_passphrase"], PASSPHRASE)
        self.assertIn("-refresh-only", calls[1]["args"])
        for call in final:
            self.assertNotIn("TF_ENCRYPTION", call["env"])
        self.assertNotIn("old-passphrase", out + err)
        for secret in SECRETS:
            self.assertNotIn(secret, out + err)

    def test_rotation_refusals(self):
        code, _, err, calls = self.run_rotate("state_2", "state_2")
        self.assertEqual(code, 1)
        self.assertIn("rename it in versions.tf first", err)
        self.assertEqual(calls, [])
        code, _, err, _ = self.run_rotate("state", "state")
        self.assertEqual(code, 1)
        self.assertIn("not re-encrypted", err)


class Bootstrap(unittest.TestCase):
    """bootstrap_state.py with a fake tofu, a fake admin helper and an in-memory bucket."""

    def run_bootstrap(self, first, final=None, env_extra=None, bucket=None):
        bucket = {} if bucket is None else bucket
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = FakeTofu(root)
            env = dict(fake.env, INFRA_STATE_PASSPHRASE=PASSPHRASE,
                       FAKE_PLAN_IMPORT=fake.fixture("import", first),
                       FAKE_PLAN_FINAL=fake.fixture("final", final or plan(*[(["no-op"], False)] * 3)),
                       FAKE_PLAN_EXIT_IMPORT="2", FAKE_PLAN_EXIT_FINAL="0")
            env.update(env_extra or {})
            values = root / "values.json"
            values.write_text(json.dumps(VALUES))
            parent = existing_parent(root)
            created = []

            def s3(method, base, path, credentials, payload=b"", extra=None):
                key = path.split("/", 1)[1] if "/" in path else ""
                if not key:
                    return (200, b"") if bucket.get("exists") else (404, b"")
                if method == "PUT":
                    if extra and extra.get("If-None-Match") == "*" and key in bucket:
                        return 412, b""
                    bucket[key] = payload
                    return 200, b""
                if method == "DELETE":
                    bucket.pop(key, None)
                    return 204, b""
                if key == "production/terraform.tfstate":
                    applied = any(call["args"][:1] == ["apply"] for call in fake.calls())
                    if applied or bucket.get("state"):
                        return 200, json.dumps({"meta": {}, "encrypted_data": "x", "serial": 1}).encode()
                    return 404, b""
                return 404, b""

            class Admin:
                DEFAULT_TOKEN = root / "token"

                @staticmethod
                def credential(path):
                    return TOKEN

            def create(token_file, args, work, log):
                created.append(args)
                bucket["exists"] = True
                return 0

            out, err = io.StringIO(), io.StringIO()
            with mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(infra_state, "cloudflare_get", lambda token, path: fake_fetch(path)), \
                    mock.patch.object(infra_state, "s3_request", s3), \
                    mock.patch.object(bootstrap_state, "load_admin", lambda: Admin), \
                    mock.patch.object(bootstrap_state, "run_admin_wrangler", create), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = bootstrap_state.main(["--var-file", str(values), "--expect", "3", "--work-dir", str(parent)])
            # The bootstrap keeps its own new directory (the log) inside the parent and nothing else changes.
            runs = assert_parent_untouched(self, parent, keep_work_dir=True)
            self.assertLessEqual(len(runs), 1)
            for run in runs:
                self.assertTrue(run.name.startswith("bootstrap-"))
                self.assertEqual(stat.S_IMODE(run.stat().st_mode), 0o700)
            leftovers = sorted(p.name for run in runs for p in run.glob("*"))
            return code, out.getvalue(), err.getvalue(), fake.calls(), created, leftovers

    def assert_clean(self, text):
        for secret in SECRETS + ("raw output",):
            self.assertNotIn(secret, text)

    def test_import_only_plan_is_applied_then_no_changes(self):
        code, out, err, calls, created, leftovers = self.run_bootstrap(plan(*[(["no-op"], True)] * 3))
        self.assertEqual(code, 0, err)
        self.assertEqual(created, [["r2", "bucket", "create", "infra-state"]])
        self.assertIn("honoured", out)
        applies = [call["args"] for call in calls if call["args"][:1] == ["apply"]]
        self.assertEqual(len(applies), 1)
        self.assertTrue(applies[0][-1].endswith("import.tfplan"))
        self.assertIn("done", out)
        self.assert_clean(out + err)
        self.assertNotIn("values.tfvars.json", leftovers)
        self.assertFalse([name for name in leftovers if name.endswith(".tfplan")])

    def test_anything_but_imports_is_refused_before_apply(self):
        for name, first in {
            "import+update": plan((["no-op"], True), (["update"], True), (["no-op"], True)),
            "create": plan((["no-op"], True), (["no-op"], True), (["create"], False)),
            "replace": plan((["no-op"], True), (["no-op"], True), (["delete", "create"], False)),
            "wrong count": plan((["no-op"], True), (["no-op"], True)),
        }.items():
            with self.subTest(case=name):
                code, out, err, calls, _, leftovers = self.run_bootstrap(first)
                self.assertEqual(code, bootstrap_state.EXIT_NOT_IMPORT_ONLY)
                self.assertFalse([call for call in calls if call["args"][:1] == ["apply"]])
                self.assertIn("nothing", bootstrap_state.NotImportOnly.__doc__)
                self.assert_clean(out + err)
                self.assertFalse([name for name in leftovers if name.endswith(".tfplan") or name.endswith(".json")])

    def test_already_bootstrapped_skips_apply(self):
        code, out, err, calls, created, _ = self.run_bootstrap(
            plan(*[(["no-op"], False)] * 3), bucket={"exists": True, "state": True})
        self.assertEqual(code, 0, err)
        self.assertEqual(created, [])
        self.assertFalse([call for call in calls if call["args"][:1] == ["apply"]])
        self.assertIn("skipped: the remote state already holds every object", out)

    def test_final_plan_must_be_no_changes(self):
        code, out, err, _, _, _ = self.run_bootstrap(
            plan(*[(["no-op"], True)] * 3), final=plan((["no-op"], False), (["update"], False), (["no-op"], False)),
            env_extra={"FAKE_PLAN_EXIT_FINAL": "2"})
        self.assertEqual(code, 1)
        self.assertIn("not \"No changes\"", err)

    def test_passphrase_required_before_anything_runs(self):
        code, out, err, calls, created, _ = self.run_bootstrap(plan(*[(["no-op"], True)] * 3),
                                                               env_extra={"INFRA_STATE_PASSPHRASE": ""})
        self.assertEqual(code, 1)
        self.assertIn("no unencrypted fallback", err)
        self.assertEqual(created, [])
        self.assertEqual([call["args"][0] for call in calls], ["version"])

    def test_requires_opentofu_1_12(self):
        code, _, err, _, _, _ = self.run_bootstrap(plan(*[(["no-op"], True)] * 3), env_extra={"FAKE_VERSION": "1.11.2"})
        self.assertEqual(code, 1)
        self.assertIn("1.12.x", err)


if __name__ == "__main__":
    unittest.main()
