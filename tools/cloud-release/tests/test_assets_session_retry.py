"""assets-session-retry.sh repeats a deploy only after Cloudflare failed to open the asset upload session."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / "assets-session-retry.sh"
UNKNOWN = (
    "An unknown error has occurred. If this error persists, please file a report in workers-sdk "
    "(https://github.com/cloudflare/workers-sdk/issues) or reach out to your account team."
)


def failure(path, code):
    """wrangler 4.142.0's report of a failed API request (one blank line between the request and the error)."""
    return (
        f"\x1b[31m✘ [ERROR] A request to the Cloudflare API (/accounts/{'0' * 32}/workers/scripts/app/{path}) failed.\x1b[0m\n"
        f"\n  {UNKNOWN} [code: {code}]\n"
    )


SESSION = failure("assets-upload-session", 10013)


class AssetsSessionRetry(unittest.TestCase):
    def run_deploy(self, *answers):
        """Runs the helper around a fake deploy that prints and exits with one (status, text) answer per call; the
        last answer repeats. Returns (status, output, calls, pauses)."""
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            for index, (status, text) in enumerate(answers, 1):
                (root / f"{index}.txt").write_text(text)
                (root / f"{index}.status").write_text(str(status))
            (root / "deploy").write_text(
                "#!/usr/bin/env bash\n"
                f'root="{root}"\n'
                'echo "$*" >> "$root/calls"\n'
                'n=$(wc -l < "$root/calls"); n=$((n))\n'
                f"[ -f \"$root/$n.txt\" ] || n={len(answers)}\n"
                'cat "$root/$n.txt" >&2\n'
                'exit "$(cat "$root/$n.status")"\n'
            )
            (root / "sleep").write_text(f'#!/usr/bin/env bash\necho "$*" >> "{root}/pauses"\n')
            for tool in ("deploy", "sleep"):
                (root / tool).chmod(0o755)
            env = {**os.environ, "PATH": f"{root}{os.pathsep}{os.environ['PATH']}"}
            result = subprocess.run(
                ["bash", str(HELPER), "deploy", "--config", "../wrangler.toml"],
                env=env, capture_output=True, text=True, check=False,
            )
            read = lambda name: (root / name).read_text().splitlines() if (root / name).exists() else []  # noqa: E731
            return result.returncode, result.stdout + result.stderr, read("calls"), read("pauses")

    def test_a_deploy_that_succeeds_runs_once(self):
        status, output, calls, pauses = self.run_deploy((0, "Current Version ID: 1\n"))
        self.assertEqual((status, len(calls), pauses), (0, 1, []))
        self.assertIn("Current Version ID: 1", output)

    def test_an_unopened_upload_session_repeats_the_same_deploy(self):
        status, output, calls, pauses = self.run_deploy((1, SESSION), (1, SESSION), (0, "Current Version ID: 1\n"))
        self.assertEqual((status, pauses), (0, ["60", "180"]))
        self.assertEqual(calls, ["--config ../wrangler.toml"] * 3)
        self.assertEqual(output.count("Retrying in"), 2)

    def test_a_third_unopened_session_fails_the_step(self):
        status, output, calls, pauses = self.run_deploy((1, SESSION))
        self.assertEqual((status, len(calls), pauses), (1, 3, ["60", "180"]))
        self.assertEqual(output.count("[code: 10013]"), 3)

    def test_every_other_failure_fails_at_once_with_its_own_status(self):
        for status, text in (
            (1, failure("versions", 10013)),  # the same code after the session opened: something may have changed
            (1, failure("assets-upload-session", 10000)),  # authentication, not the transient session error
            (1, failure("assets-upload-session", 10013).replace("[code: 10013]", "")),
            (2, "Refused: --var is added by this wrapper only.\n"),  # deploy-vars.mjs refused the command
        ):
            with self.subTest(text=text.splitlines()[0][-60:]):
                code, _, calls, pauses = self.run_deploy((status, text), (0, ""))
                self.assertEqual((code, len(calls), pauses), (status, 1, []))

    def test_a_command_is_required(self):
        result = subprocess.run(["bash", str(HELPER)], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
