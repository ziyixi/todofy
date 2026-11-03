"""The private checkout fetches one pinned commit quietly, over a pinned host, and keeps no credential."""

import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from workflow_sources import ROOT, workflow_data

ACTION = ROOT / ".github/actions/private-checkout/action.yml"
REPOSITORY = "ziyixi/todofy-private"
# GitHub's published SSH host key fingerprints (https://api.github.com/meta, `ssh_key_fingerprints`).
GITHUB_FINGERPRINTS = {
    "+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
    "p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
    "uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
}
# Records each call, then serves the synthetic repository the way GitHub's SSH endpoint would.
FAKE_SSH = """\
import json, os, stat, sys
args = sys.argv[1:]
key = args[args.index("-i") + 1]
known = next(a.split("=", 1)[1] for a in args if a.startswith("UserKnownHostsFile="))
with open(key) as handle:
    key_text = handle.read()
with open(known) as handle:
    known_text = handle.read()
record = {"args": args, "key": key_text, "key_path": key, "key_mode": stat.S_IMODE(os.stat(key).st_mode),
          "known_hosts": known_text}
with open(os.environ["FAKE_SSH_RECORD"], "a") as handle:
    handle.write(json.dumps(record) + "\\n")
if os.environ.get("FAKE_SSH_FAIL"):
    print("fatal: synthetic-private-subject", file=sys.stderr)
    sys.exit(255)
if args[-2:] != ["git@github.com", "git-upload-pack '" + os.environ["FAKE_SSH_EXPECTED"] + ".git'"]:
    sys.exit(254)
os.execvp("git", ["git", "upload-pack", os.environ["FAKE_SSH_REPOSITORY"]])
"""


def checkout_script():
    steps = workflow_data(ACTION)["runs"]["steps"]
    return next(step["run"] for step in steps if "run" in step)


def git_environment():
    return {
        **os.environ,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_AUTHOR_NAME": "Synthetic",
        "GIT_COMMITTER_NAME": "Synthetic",
        "GIT_AUTHOR_EMAIL": "synthetic@example.invalid",
        "GIT_COMMITTER_EMAIL": "synthetic@example.invalid",
    }


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, env=git_environment(),
                          capture_output=True, text=True, check=True).stdout.strip()


def run_checkout(workspace, temporary, repository, *, revision, path, history,
                 key="synthetic-read-only-key\n", fail=False):
    """Run the action's own step against a local repository behind a recording stand-in for ssh."""
    tools = Path(temporary) / "fake-ssh"
    tools.mkdir(exist_ok=True)
    (tools / "ssh.py").write_text(FAKE_SSH)
    ssh = tools / "ssh"
    ssh.write_text('#!/bin/sh\nexec "$FAKE_SSH_PYTHON" "$FAKE_SSH_PROGRAM" "$@"\n')
    ssh.chmod(0o755)
    runner_temp = Path(temporary) / "runner-temp"
    runner_temp.mkdir(exist_ok=True)
    record = Path(temporary) / "ssh-record.jsonl"
    record.unlink(missing_ok=True)
    result = subprocess.run(
        ["bash", "-e", "-c", checkout_script()],
        cwd=workspace,
        env={
            **os.environ,
            "PATH": f"{tools}{os.pathsep}{os.environ['PATH']}",
            "RUNNER_TEMP": str(runner_temp),
            "PRIVATE_CHECKOUT_REVISION": revision,
            "PRIVATE_CHECKOUT_PATH": path,
            "PRIVATE_CHECKOUT_KEY": key,
            "PRIVATE_CHECKOUT_HISTORY": history,
            "FAKE_SSH_PYTHON": sys.executable,
            "FAKE_SSH_PROGRAM": str(tools / "ssh.py"),
            "FAKE_SSH_RECORD": str(record),
            "FAKE_SSH_REPOSITORY": str(repository),
            "FAKE_SSH_EXPECTED": REPOSITORY,
            "FAKE_SSH_FAIL": "1" if fail else "",
        },
        capture_output=True, text=True, check=False,
    )
    calls = [json.loads(line) for line in record.read_text().splitlines()] if record.exists() else []
    return result, calls, runner_temp


def synthetic_repository(directory):
    """Three commits whose subjects stand for private branch and application names."""
    source = Path(directory) / "source"
    source.mkdir()
    git(source, "init", "--quiet", "-b", "synthetic-private-branch")
    commits = []
    for index in range(3):
        (source / "file.txt").write_text(str(index))
        git(source, "add", "file.txt")
        git(source, "commit", "--quiet", "-m", f"Merge synthetic-private-branch {index}")
        commits.append(git(source, "rev-parse", "HEAD"))
    return source, commits


class PrivateCheckout(unittest.TestCase):
    def test_every_private_fetch_uses_the_quiet_action(self):
        sources = sorted((ROOT / ".github/workflows").glob("*.yml")) + sorted(
            (ROOT / ".github/actions").glob("*/action.yml"))
        callers = []
        for path in sources:
            if path == ACTION:
                continue
            text = path.read_text()
            # actions/checkout prints the fetched commit's subject; no workflow may fetch the private repository with it.
            self.assertNotIn(REPOSITORY, text, path)
            document = workflow_data(path)
            jobs = document.get("jobs", {}).values() if "jobs" in document else [document["runs"]]
            for job in jobs:
                for step in job.get("steps", []):
                    if step.get("uses") == "./.github/actions/private-checkout":
                        callers.append((path.name, step["with"]))
        self.assertEqual(sorted(name for name, _ in callers),
                         ["action.yml", "private-check.yml", "private-check.yml", "private-release.yml"])
        for name, values in callers:
            with self.subTest(caller=name, path=values["path"]):
                self.assertEqual(set(values), {"revision", "path", "ssh-key", "history"})
                self.assertIn(values["history"], {"commit", "ancestry"})
                self.assertIn(values["ssh-key"], {"${{ secrets.private_ssh_key }}", "${{ inputs.private-ssh-key }}"})
        self.assertIn("git@github.com:" + REPOSITORY + ".git", ACTION.read_text())

    def test_known_hosts_are_githubs_published_keys(self):
        lines = [line.strip() for line in checkout_script().splitlines() if line.strip().startswith("github.com ")]
        self.assertEqual([line.split()[1] for line in lines], ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"])
        fingerprints = {
            base64.b64encode(hashlib.sha256(base64.b64decode(line.split()[2])).digest()).decode().rstrip("=")
            for line in lines
        }
        self.assertEqual(fingerprints, GITHUB_FINGERPRINTS)

    def test_fetches_the_pinned_commit_silently_and_keeps_no_credential(self):
        with tempfile.TemporaryDirectory() as directory:
            source, commits = synthetic_repository(directory)
            workspace = Path(directory) / "workspace"
            (workspace / "private").mkdir(parents=True)
            for history, path, shallow in (("commit", "private", "true"), ("ancestry", "./.private-baseline", "false")):
                with self.subTest(history=history):
                    result, calls, runner_temp = run_checkout(
                        workspace, directory, source, revision=commits[1], path=path, history=history,
                        key="-----SYNTHETIC KEY-----\r\nbody\r\n\n\n",
                    )
                    self.assertEqual((result.returncode, result.stdout + result.stderr), (0, ""))
                    destination = workspace / path
                    self.assertEqual(git(destination, "rev-parse", "HEAD"), commits[1])
                    self.assertEqual(git(destination, "rev-parse", "--is-shallow-repository"), shallow)
                    present = subprocess.run(["git", "cat-file", "-e", commits[0] + "^{commit}"], cwd=destination,
                                             env=git_environment(), capture_output=True, check=False)
                    self.assertEqual(present.returncode == 0, history == "ancestry")
                    self.assertEqual(git(destination, "for-each-ref"), "")
                    local = git(destination, "config", "--local", "--list")
                    self.assertNotRegex(local, r"(?im)^(remote|url|core\.sshcommand|http)\.")
                    self.assertFalse((destination / ".git/FETCH_HEAD").exists())
                    self.assertEqual(len(calls), 1)
                    call = calls[0]
                    self.assertEqual(call["key"], "-----SYNTHETIC KEY-----\nbody\n")
                    self.assertEqual(call["key_mode"], 0o600)
                    self.assertTrue(call["key_path"].startswith(str(runner_temp)))
                    self.assertFalse(Path(call["key_path"]).exists())
                    self.assertEqual([path.name for path in runner_temp.iterdir()
                                      if path.name.startswith("private-checkout.")], [])
                    arguments = " ".join(call["args"])
                    for option in ("-F /dev/null", "-o IdentitiesOnly=yes", "-o IdentityAgent=none",
                                   "-o BatchMode=yes", "-o StrictHostKeyChecking=yes",
                                   "-o GlobalKnownHostsFile=/dev/null"):
                        self.assertIn(option, arguments)
                    self.assertEqual(
                        [line.split()[:2] for line in call["known_hosts"].splitlines()],
                        [["github.com", "ssh-ed25519"], ["github.com", "ecdsa-sha2-nistp256"],
                         ["github.com", "ssh-rsa"]],
                    )

    def test_failures_print_only_a_fixed_code_and_remove_the_key(self):
        with tempfile.TemporaryDirectory() as directory:
            source, commits = synthetic_repository(directory)
            workspace = Path(directory) / "workspace"
            workspace.mkdir()
            for revision, fail in ((commits[2], True), ("f" * 40, False)):
                with self.subTest(fail=fail):
                    path = "failed-" + revision[:4]
                    result, calls, runner_temp = run_checkout(
                        workspace, directory, source, revision=revision, path=path, history="commit", fail=fail)
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(result.stdout + result.stderr, "::error::PRIVATE_CHECKOUT_FAILED\n")
                    self.assertEqual(len(calls), 1)
                    self.assertFalse(Path(calls[0]["key_path"]).exists())
                    self.assertEqual([path.name for path in runner_temp.iterdir()
                                      if path.name.startswith("private-checkout.")], [])

    def test_invalid_inputs_are_refused_before_any_fetch(self):
        with tempfile.TemporaryDirectory() as directory:
            source, commits = synthetic_repository(directory)
            workspace = Path(directory) / "workspace"
            (workspace / "occupied").mkdir(parents=True)
            (workspace / "occupied/file").write_text("existing")
            (workspace / "file").write_text("existing")
            valid = {"revision": commits[0], "path": "private", "history": "commit"}
            for change in ({"revision": commits[0][:12]}, {"revision": "HEAD"}, {"revision": commits[0].upper()},
                           {"history": "full"}, {"path": ""}, {"path": "/private"}, {"path": "../private"},
                           {"path": "a/../../private"}, {"path": "occupied"}, {"path": "file"}):
                with self.subTest(change=change):
                    result, calls, _ = run_checkout(workspace, directory, source, **{**valid, **change})
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(result.stdout + result.stderr, "::error::PRIVATE_CHECKOUT_INPUT_INVALID\n")
                    self.assertEqual(calls, [])
            result, calls, _ = run_checkout(workspace, directory, source, key="", **valid)
            self.assertEqual(result.stdout + result.stderr, "::error::PRIVATE_CHECKOUT_INPUT_INVALID\n")
            self.assertEqual(calls, [])
            self.assertFalse((workspace / "private").exists())

    def test_the_key_is_only_tested_and_written_to_its_file_without_tracing(self):
        script = checkout_script()
        self.assertNotRegex(script, r"set -[a-z]*x")
        self.assertEqual(
            re.findall(r"^.*PRIVATE_CHECKOUT_KEY.*$", script, re.M),
            [
                '[ -n "$PRIVATE_CHECKOUT_KEY" ] || refuse PRIVATE_CHECKOUT_INPUT_INVALID',
                '(umask 077 && printf \'%s\\n\' "$(printf \'%s\' "$PRIVATE_CHECKOUT_KEY" | tr -d \'\\r\')" > "$credentials/key")',
            ],
        )


if __name__ == "__main__":
    unittest.main()
