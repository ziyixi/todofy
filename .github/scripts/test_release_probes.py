"""Run the real release probes and publication scripts against synthetic local providers."""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from typing import ClassVar

from workflow_sources import effective_ci

REPO = Path(__file__).absolute().parents[2]
SHA = "a" * 40
REPOSITORY = "ziyixi/todofy"
RUN_ID = "900"


def needs(block):
    match = re.search(r"^    needs: \[([^\]]+)\]$", block, re.MULTILINE)
    return match.group(1).split(", ") if match else []


def job_condition(block):
    return re.search(r"(?ms)^    if: >-\n(.*?)(?=^    \S)", block).group(1)


def source_files(pattern):
    """Inspect repository source, excluding dependency installs and Bazel's output symlinks."""
    for directory in REPO.iterdir():
        if (
            directory.is_symlink()
            or not directory.is_dir()
            or directory.name in {"node_modules", ".venv"}
        ):
            continue
        for source in directory.glob(pattern.removeprefix("*/")):
            if "node_modules" not in source.relative_to(REPO).parts:
                yield source


def workflow_jobs():
    text = effective_ci().split("\njobs:\n", 1)[1]
    starts = [
        (match.start(), match.group(1))
        for match in re.finditer(r"^  ([a-z][a-z0-9-]*):\n", text, re.MULTILINE)
    ]
    blocks = {}
    for index, (start, name) in enumerate(starts):
        end = starts[index + 1][0] if index + 1 < len(starts) else len(text)
        blocks[name] = text[start:end]
    return blocks


def workflow_run_step(job_name, step_name):
    """Resolve a run step and its effective cwd, including the job's run defaults."""
    block = workflow_jobs()[job_name]
    header = block.split("    steps:\n", 1)[0]
    default = re.search(r"^        working-directory: (\S+)$", header, re.MULTILINE)
    step = block.split(f"- name: {step_name}\n", 1)[1].split("\n      - ", 1)[0]
    override = re.search(r"^        working-directory: (\S+)$", step, re.MULTILINE)
    directory = override.group(1) if override else default.group(1) if default else "."
    body = step.split("        run: |\n", 1)[1]
    lines = []
    for line in body.splitlines():
        if line.strip() and not line.startswith("          "):
            break
        lines.append(line[10:])
    return "\n".join(lines) + "\n", Path(directory)


class RecallExtensionRelease(unittest.TestCase):
    """recall's Chrome extension is never deployed; "Recall extension release" keeps each new version as a GitHub
    Release (recall/extension/README.md). It publishes the build Recall checks tested, only on main, with the one write
    permission in ci.yml, and nothing waits for it. Its step runs here against a stubbed gh and a synthetic build."""

    JOB = "recall-extension-release"
    STEP = "Publish the extension's version unless its tag exists"
    VERSION = "2026.1011.1234"
    TAG = f"recall-extension-v{VERSION}"

    @property
    def run_url(self):
        return f"https://github.com/{REPOSITORY}/actions/runs/{RUN_ID}"

    def test_it_has_the_only_write_permission_and_nothing_waits_for_it(self):
        blocks = workflow_jobs()
        block = blocks[self.JOB]
        self.assertEqual(
            re.findall(
                r"^      (\w+): (\w+)$",
                block.split("    permissions:\n", 1)[1].split("    steps:", 1)[0],
                re.MULTILINE,
            ),
            [("contents", "write"), ("actions", "read")],
        )
        self.assertEqual(
            [name for name, other in blocks.items() if "contents: write" in other],
            [self.JOB],
        )
        self.assertRegex(effective_ci(), r"\npermissions:\n  contents: read\n")
        # GITHUB_TOKEN only: no secret, no deployment environment.
        self.assertNotIn("secrets", block)
        self.assertNotRegex(block, r"(?m)^ +environment:")
        for name, other in blocks.items():
            with self.subTest(job=name):
                self.assertNotIn(self.JOB, needs(other))
        condition = job_condition(block)
        self.assertIn("github.ref == 'refs/heads/main'", condition)
        self.assertIn(
            "(github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
            condition,
        )

    def test_it_publishes_the_checked_zip_without_rebuilding(self):
        block = workflow_jobs()[self.JOB]
        self.assertIn("name: recall-extensions-${{ github.sha }}\n", block)
        self.assertIn(
            "run-id: ${{ needs.changes.outputs.artifact_run_id || github.run_id }}\n",
            block,
        )
        producer = workflow_jobs()["artifacts"]
        self.assertIn('bazel build "$RELEASE_TARGET" "${options[@]}"', producer)
        self.assertIn('options=(--stamp "--embed_label=$GITHUB_SHA"', producer)
        self.assertIn("name: recall-extensions-${{ github.sha }}\n", producer)
        script = workflow_run_step(self.JOB, self.STEP)[0]
        self.assertLess(
            script.index("git/matching-refs/tags/"), script.index("gh release create")
        )
        self.assertNotIn("zip -", script)

    def publish(
        self,
        refs="",
        version_name=SHA[:7],
        fail_api=False,
        reused="",
        orion_version=None,
    ):
        """Runs the step on a synthetic build. Returns (exit code, output, gh calls, the published zip's names, notes)."""
        if (
            shutil.which("jq") is None or shutil.which("zip") is None
        ) and os.environ.get("GITHUB_ACTIONS") != "true":
            self.skipTest("needs jq and zip (the runner has both)")
        with tempfile.TemporaryDirectory() as root:
            build = Path(root, "recall-extension")
            (build / "icons").mkdir(parents=True)
            manifest = {
                "manifest_version": 3,
                "name": "recall",
                "version": self.VERSION,
                "version_name": version_name,
            }
            (build / "manifest.json").write_text(json.dumps(manifest))
            for name in (
                "sw.js",
                "capture.js",
                "options.html",
                "options.js",
                "options.css",
                "icons/16.png",
            ):
                (build / name).write_text("synthetic\n")
            orion = Path(root, "recall-orion")
            shutil.copytree(build, orion)
            orion_manifest = {
                **manifest,
                "manifest_version": 2,
                "version": orion_version or self.VERSION,
            }
            (orion / "manifest.json").write_text(json.dumps(orion_manifest))
            for folder, stem in ((build, "recall-extension"), (orion, "recall-orion")):
                with zipfile.ZipFile(
                    Path(root) / f"{stem}-{SHA[:7]}.zip", "w"
                ) as packed:
                    for file in sorted(folder.rglob("*")):
                        if file.is_file():
                            packed.write(file, file.relative_to(folder).as_posix())
            bin_dir = Path(root, "bin")
            bin_dir.mkdir()
            Path(root, "refs.txt").write_text(refs)
            gh = bin_dir / "gh"
            gh.write_text(
                "#!/usr/bin/env bash\n"
                f'echo "$*" >> "{root}/calls"\n'
                'case "$1 $2" in\n'
                f'  "api repos/{REPOSITORY}/git/matching-refs/tags/{self.TAG}") '
                + ("exit 1 ;;\n" if fail_api else f'cat "{root}/refs.txt" ;;\n')
                + f'  "release create") cp "$4" "{root}/published.zip"; cp "$5" "{root}/orion.zip"; cp "${{11}}" "{root}/notes.md" ;;\n'
                '  *) echo "unexpected gh call" >&2; exit 3 ;;\n'
                "esac\n"
            )
            gh.chmod(0o755)
            runner_temp = Path(root, "runner")
            runner_temp.mkdir()
            env = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                "GH_TOKEN": "synthetic-token",
                "GH_REPO": REPOSITORY,
                "ARCHIVE_DIR": root,
                "BUILD_DIR": str(build),
                "ORION_DIR": str(orion),
                "RUN_URL": self.run_url,
                "REUSED_RUN_URL": reused,
                "GITHUB_SHA": SHA,
                "RUNNER_TEMP": str(runner_temp),
                "GITHUB_STEP_SUMMARY": str(Path(root, "summary.md")),
            }
            script, directory = workflow_run_step(self.JOB, self.STEP)
            self.assertEqual(directory, Path("."))
            result = subprocess.run(
                ["bash", "-e", "-o", "pipefail", "-c", script],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            calls = (
                Path(root, "calls").read_text().splitlines()
                if Path(root, "calls").exists()
                else []
            )
            names, notes = [], ""
            if Path(root, "published.zip").exists():
                self.assertEqual(
                    Path(root, "published.zip").read_bytes(),
                    (Path(root) / f"recall-extension-{SHA[:7]}.zip").read_bytes(),
                )
                with zipfile.ZipFile(Path(root, "published.zip")) as archive:
                    names = sorted(archive.namelist())
                notes = Path(root, "notes.md").read_text()
                with zipfile.ZipFile(Path(root, "orion.zip")) as archive:
                    self.assertEqual(
                        json.loads(archive.read("manifest.json"))["manifest_version"], 2
                    )
                    self.assertIn("sw.js", archive.namelist())
            return result.returncode, result.stdout + result.stderr, calls, names, notes

    def test_a_new_version_is_published_with_its_zip_commit_and_run(self):
        # A longer tag that only starts with this one is another version.
        for refs in ("", f"refs/tags/{self.TAG}5\n"):
            with self.subTest(refs=refs):
                code, output, calls, names, notes = self.publish(refs=refs)
                self.assertEqual(code, 0, output)
                self.assertEqual(
                    calls[0],
                    f"api repos/{REPOSITORY}/git/matching-refs/tags/{self.TAG} --jq .[].ref",
                )
                self.assertRegex(
                    calls[1],
                    rf"^release create {re.escape(self.TAG)} \S+/recall-extension-v{re.escape(self.VERSION)}\.zip "
                    rf"\S+/recall-orion-v{re.escape(self.VERSION)}\.zip --target {SHA} --title recall extension {re.escape(self.VERSION)} --notes-file \S+$",
                )
                # The files at the zip's root, as `npm run install-extension -- <zip>` reads them.
                self.assertEqual(
                    names,
                    [
                        "capture.js",
                        "icons/16.png",
                        "manifest.json",
                        "options.css",
                        "options.html",
                        "options.js",
                        "sw.js",
                    ],
                )
                self.assertIn(SHA, notes)
                self.assertIn(f"CI run: {self.run_url}", notes)
                self.assertIn("npm run install-extension -- <this zip>", notes)
                self.assertNotIn("Checked and built in", notes)
        reused = f"https://github.com/{REPOSITORY}/actions/runs/800"
        _, _, _, _, notes = self.publish(reused=reused)
        self.assertIn(f"Checked and built in: {reused}", notes)

    def test_a_mismatched_orion_build_publishes_nothing(self):
        code, output, calls, _, _ = self.publish(orion_version="2026.1010.900")
        self.assertEqual(code, 1, output)
        self.assertIn("not the same tested build", output)
        self.assertEqual(calls, [])

    def test_an_existing_tag_publishes_nothing(self):
        code, output, calls, names, _ = self.publish(refs=f"refs/tags/{self.TAG}\n")
        self.assertEqual(code, 0, output)
        self.assertIn(f"{self.TAG} exists: nothing to publish", output)
        self.assertEqual(len(calls), 1)
        self.assertEqual(names, [])

    def test_another_commits_build_or_an_unknown_tag_state_publishes_nothing(self):
        code, output, calls, _, _ = self.publish(version_name="c" * 7)
        self.assertEqual(code, 1, output)
        self.assertIn("not this commit's extension build", output)
        self.assertEqual(calls, [])
        code, output, calls, _, _ = self.publish(fail_api=True)
        self.assertNotEqual(code, 0, output)
        self.assertEqual(len(calls), 1)


class WebsiteRelease(unittest.TestCase):
    """Daily dispatch, Home and code pushes use the same trusted release and rollback lock."""

    RELEASE = REPO / ".github" / "workflows" / "website-release.yml"

    def release_jobs(self):
        text = self.RELEASE.read_text().split("\njobs:\n", 1)[1]
        starts = [
            (m.start(), m.group(1))
            for m in re.finditer(r"^  ([a-z][a-z0-9-]*):\n", text, re.MULTILINE)
        ]
        return {
            name: text[
                start : starts[index + 1][0] if index + 1 < len(starts) else len(text)
            ]
            for index, (start, name) in enumerate(starts)
        }

    def test_website_deploy_dispatches_the_release_workflow_with_fixed_inputs(self):
        block = workflow_jobs()["website-deploy"]
        self.assertIn(
            'gh workflow run website-release.yml --repo "$GITHUB_REPOSITORY" --ref main',
            block,
        )
        for flag in (
            "-f operation=release",
            '-f confirmation="release:${SITE_URL#https://}"',
            "-f force_build=false",
            "-f allow_empty=false",
            "-f trigger=push",
        ):
            self.assertIn(flag, block)
        self.assertIn("      actions: write\n", block)
        self.assertIn("      contents: read\n", block)
        for absent in ("deployments:", "concurrency:", "environment:", "secrets."):
            self.assertNotIn(absent, block)
        self.assertNotIn("workflow_call:", self.RELEASE.read_text())

    def test_the_release_pins_a_green_main_commit_before_installing_dependencies(self):
        jobs = self.release_jobs()
        self.assertEqual(set(jobs), {"release"})
        block = jobs["release"]
        self.assertIn(
            "    if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'\n",
            block,
        )
        pin = block.index(
            "- name: Check out the newest main commit that passed the CI gate\n"
        )
        install = block.index("- name: Install the selected Node workspaces\n")
        context = block.index(
            "- name: Assert the trusted release context and the pinned commit\n"
        )
        self.assertLess(pin, install)
        self.assertLess(install, context)
        self.assertIn("uses: ./.github/actions/setup-workspace", block[install:context])
        self.assertNotIn("secrets.", block[install:context])
        self.assertNotIn("GITHUB_TOKEN:", block[install:context])
        self.assertIn("scripts/release/green-commit.ts", block[pin:install])
        self.assertIn(
            'git -c advice.detachedHead=false checkout --detach "$sha"',
            block[pin:install],
        )
        self.assertIn("          fetch-depth: 0\n", block)
        self.assertIn("run: pnpm release context", block)
        self.assertIn("      group: website-production\n", block)
        self.assertIn("      queue: max\n", block)
        self.assertIn("      cancel-in-progress: false\n", block)
        self.assertIn("      name: production\n", block)

    def test_the_dispatch_contract_correlates_a_request_uuid_and_keeps_push_compatibility(
        self,
    ):
        text = self.RELEASE.read_text()
        self.assertIn(
            "run-name: ${{ format('Website {0} ({1}) [{2}]', inputs.operation, inputs.trigger, inputs.request_id) }}",
            text,
        )
        self.assertIn("        options: [release, bootstrap, recovery]", text)
        self.assertIn("        options: [manual, cron, push]", text)
        self.assertIn("      request_id:\n", text)
        self.assertIn("      RELEASE_REQUEST_ID: ${{ inputs.request_id }}\n", text)
        self.assertNotIn("operation == 'status'", text)
        self.assertNotIn("operation != 'status'", text)

    def test_only_the_snapshot_step_receives_notion_credentials(self):
        text = self.RELEASE.read_text()
        self.assertEqual(text.count("secrets.WEBSITE_NOTION_TOKEN"), 1)
        self.assertEqual(text.count("secrets.WEBSITE_NOTION_DATA_SOURCE_ID"), 1)
        self.assertEqual(text.count("secrets.CF_API_TOKEN"), 6)
        steps = self.release_jobs()["release"].split("\n      - ")[1:]
        with_token = sorted(
            step.split("\n", 1)[0].removeprefix("name: ")
            for step in steps
            if "GITHUB_TOKEN: ${{ github.token }}" in step
        )
        self.assertEqual(
            with_token,
            sorted(
                [
                    "Check out the newest main commit that passed the CI gate",
                    "Assert the trusted release context and the pinned commit",
                    "Enforce the GitHub Deployment state gate",
                    "Reconcile a blocked release with what production serves",
                    "Record the completed content check",
                    "Record the release in progress",
                    "Mark the release successful",
                    "Record the failure",
                    "Finalize the content-sync receipt",
                ]
            ),
        )
        self.assertEqual(
            text.count("GITHUB_TOKEN: ${{ github.token }}"), len(with_token)
        )
        self.assertNotIn("GH_TOKEN", text)
        self.assertNotIn("scripts/notion/", text)

    def test_completed_checks_and_final_receipts_surround_the_existing_publish_and_rollback(
        self,
    ):
        block = self.release_jobs()["release"]
        prepare = block.index("- name: Prepare the Notion snapshot\n")
        decide = block.index("- name: Decide whether the identity changed\n")
        receipt = block.index("- name: Record the completed content check\n")
        build = block.index("- name: Build the static export\n")
        rollback = block.index("- name: Restore the recorded previous version\n")
        finalize = block.index("- name: Finalize the content-sync receipt\n")
        self.assertLess(prepare, decide)
        self.assertLess(decide, receipt)
        self.assertLess(receipt, build)
        self.assertLess(rollback, finalize)
        self.assertIn(
            "        if: steps.decision.outcome == 'success'\n", block[receipt:build]
        )
        self.assertIn("        if: always()\n", block[finalize:])
        for field in (
            "SYNC_JOB_STATUS",
            "SYNC_GATE_OUTCOME",
            "SYNC_BOOTSTRAP_REQUIRED",
            "SYNC_RECORD_OUTCOME",
            "SYNC_BUILD_OUTCOME",
            "SYNC_ARTIFACT_OUTCOME",
            "SYNC_LIVE_VERIFIED",
            "SYNC_RELEASE_MARKED",
        ):
            self.assertIn(field + ":", block[finalize:])
        self.assertIn("steps.live.outputs.live_verified == 'true'", block[finalize:])
        self.assertIn("run: pnpm release sync-finalize", block[finalize:])
        self.assertIn("run: pnpm release check-baseline", block)
        self.assertIn("run: pnpm release verify-artifact", block)
        self.assertIn("run: pnpm release verify-live", block)
        self.assertIn("run: pnpm release rollback", block)
        self.assertIn("run: pnpm release mark-failure", block)


class WebsiteDailySchedule(unittest.TestCase):
    """The daily Worker owns the sole clock; Actions only accepts release dispatches."""

    def test_github_has_no_second_scheduler_or_status_only_job(self):
        text = WebsiteRelease.RELEASE.read_text()
        events = text.split("\non:\n", 1)[1].split("\npermissions:\n", 1)[0]
        self.assertIn("  workflow_dispatch:", events)
        self.assertNotIn("  schedule:", events)
        self.assertEqual(set(WebsiteRelease().release_jobs()), {"release"})
        for retired in (
            "website/scripts/release/scheduled-reconcile.ts",
            "website/scripts/release/scheduled-dispatch.ts",
            "website/scripts/notion/sync-status.ts",
            "website/scripts/notion/update-site-summary.ts",
            "website/scripts/notion/status.ts",
        ):
            with self.subTest(retired=retired):
                self.assertFalse((REPO / retired).exists())
        self.assertNotIn("WEBSITE_SCHEDULED_RECONCILE", text)


@unittest.skipUnless(shutil.which("bash"), "needs bash (on the runner)")
class AccessProbe(unittest.TestCase):
    """The Dashboard deploy's Access probe, run as the workflow runs it, against a stubbed curl.

    Only Access's own login page for this host passes; a 302 to anywhere else on the team domain (for
    example a zone Redirect Rule to the App Launcher, which runs before Access and the Worker) fails.
    """

    ISSUER = "https://example.cloudflareaccess.com"
    HOST = "home.example.org"

    def script(self, job="dashboard-deploy"):
        return workflow_run_step(
            job, "Check that Access answers unauthenticated requests"
        )[0]

    def probe(self, *answers, job="dashboard-deploy"):
        """Runs the step with the issuer and host the config step reads from dashboard/wrangler.toml; curl
        answers each request with the next of `answers` ("<code> <location>"), the last one repeating."""
        with tempfile.TemporaryDirectory() as root:
            # GitHub's workspace may contain spaces; the helper must be independent of app defaults.
            workspace = Path(root, "workspace with spaces")
            workspace.symlink_to(REPO, target_is_directory=True)
            bin_dir = Path(root, "bin")
            bin_dir.mkdir()
            Path(root, "answers").write_text("\n".join(answers) + "\n")
            curl = bin_dir / "curl"
            curl.write_text(
                "#!/usr/bin/env bash\n"
                f'answers="{root}/answers"\n'
                # The last answer repeats for every later request.
                'line=$(head -n 1 "$answers")\n'
                'if [ "$(wc -l < "$answers")" -gt 1 ]; then tail -n +2 "$answers" > "$answers.next"; mv "$answers.next" "$answers"; fi\n'
                'printf "%s" "$line"\n'
            )
            (bin_dir / "sleep").write_text("#!/usr/bin/env bash\nexit 0\n")
            for tool in (curl, bin_dir / "sleep"):
                tool.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                "ACCESS_ISSUER": self.ISSUER,
                "PUBLIC_HOST": self.HOST,
                "GITHUB_WORKSPACE": str(workspace),
            }
            script, directory = workflow_run_step(
                job, "Check that Access answers unauthenticated requests"
            )
            result = subprocess.run(
                ["bash", "-e", "-c", script],
                cwd=workspace / directory,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            return result.returncode, result.stdout + result.stderr

    def test_every_app_probe_runs_from_its_effective_workflow_directory(self):
        login = f"{self.ISSUER}/cdn-cgi/access/login/{self.HOST}"
        jobs = ("dashboard-deploy", "links-deploy", "watch-deploy")
        for job in jobs:
            with self.subTest(job=job):
                code, output = self.probe(f"302 {login}", job=job)
                self.assertEqual(code, 0, output)
                code, output = self.probe("200 ", job=job)
                self.assertEqual(code, 1, output)
                self.assertIn("was answered with", output)

    def test_links_deploy_runs_the_same_probe_on_the_owners_half(self):
        """The links deploy's probe is this very script too, fed from links/wrangler.toml, on the paths the path-scoped
        Access app covers: its exact destination /_, the launcher /_/ and the owner API."""
        name = "- name: Check that Access answers unauthenticated requests\n"
        step = lambda job: (
            workflow_jobs()[job].split(name, 1)[1].split("\n      - ", 1)[0]
        )

        def body(job):
            """The step's `run: |` lines only (the next step's leading comments are not part of it)."""
            lines = step(job).split("        run: |\n", 1)[1].splitlines()
            return "\n".join(
                line
                for line in lines
                if not line.strip() or line.startswith("          ")
            ).rstrip()

        links = body("links-deploy")
        self.assertIn(
            'bash "$GITHUB_WORKSPACE/tools/deploy-probes/access.sh" /_ /_/ /_/api/v1/links',
            links,
        )
        self.assertEqual(
            links.replace(
                'access.sh" /_ /_/ /_/api/v1/links', 'access.sh" / /api/v1/homeView'
            ),
            body("dashboard-deploy"),
        )
        self.assertIn(
            "ACCESS_ISSUER: ${{ steps.config.outputs.access_issuer }}",
            step("links-deploy"),
        )
        self.assertIn(
            "PUBLIC_HOST: ${{ steps.config.outputs.host }}", step("links-deploy")
        )
        block = workflow_jobs()["links-deploy"]
        config = block.split(
            "- name: Read the host and the Access issuer from the committed config\n", 1
        )[1]
        self.assertIn('open("wrangler.toml", "rb")', config.split("\n      - ", 1)[0])
        self.assertLess(
            block.index("- name: Check that production runs this commit\n"),
            block.index(name),
        )

    def test_watch_deploy_runs_the_same_probe_on_the_whole_host(self):
        """The watch deploy's probe is this very script too, fed from watch/wrangler.toml, on the inbox, the owner API
        and the add-from-phone page: the whole host is behind the Access application "watch"."""
        name = "- name: Check that Access answers unauthenticated requests\n"
        step = lambda job: (
            workflow_jobs()[job].split(name, 1)[1].split("\n      - ", 1)[0]
        )

        def body(job):
            """The step's `run: |` lines only (the next step's leading comments are not part of it)."""
            lines = step(job).split("        run: |\n", 1)[1].splitlines()
            return "\n".join(
                line
                for line in lines
                if not line.strip() or line.startswith("          ")
            ).rstrip()

        watch = body("watch-deploy")
        self.assertIn(
            'bash "$GITHUB_WORKSPACE/tools/deploy-probes/access.sh" / /api/v1/watches /new',
            watch,
        )
        self.assertEqual(
            watch.replace(
                'access.sh" / /api/v1/watches /new', 'access.sh" / /api/v1/homeView'
            ),
            body("dashboard-deploy"),
        )
        self.assertIn(
            "ACCESS_ISSUER: ${{ steps.config.outputs.access_issuer }}",
            step("watch-deploy"),
        )
        self.assertIn(
            "PUBLIC_HOST: ${{ steps.config.outputs.host }}", step("watch-deploy")
        )
        block = workflow_jobs()["watch-deploy"]
        config = block.split(
            "- name: Read the host and the Access issuer from the committed config\n", 1
        )[1]
        self.assertIn('open("wrangler.toml", "rb")', config.split("\n      - ", 1)[0])
        self.assertLess(
            block.index("- name: Check that production runs this commit\n"),
            block.index(name),
        )

    def test_the_issuer_and_host_come_from_the_committed_config(self):
        block = workflow_jobs()["dashboard-deploy"]
        name = "- name: Check that Access answers unauthenticated requests\n"
        step = block.split(name, 1)[1].split("\n      - ", 1)[0]
        self.assertIn("ACCESS_ISSUER: ${{ steps.config.outputs.access_issuer }}", step)
        self.assertIn("PUBLIC_HOST: ${{ steps.config.outputs.host }}", step)
        config = block.split(
            "- name: Read the host and the Access issuer from the committed config\n", 1
        )[1]
        self.assertIn('open("wrangler.toml", "rb")', config.split("\n      - ", 1)[0])

    def test_the_login_page_for_this_host_passes(self):
        login = f"{self.ISSUER}/cdn-cgi/access/login/{self.HOST}"
        code, output = self.probe(
            f"302 {login}?kid=abc&redirect_url=%2F",
            f"302 {login}?kid=abc&redirect_url=%2Fapi",
        )
        self.assertEqual(code, 0, output)
        code, output = self.probe("000 ", f"302 {login}", f"302 {login}/")
        self.assertEqual(code, 0, output)

    def test_a_redirect_to_the_team_domain_root_fails(self):
        """A Redirect Rule to the App Launcher would leave the dashboard unreachable."""
        code, output = self.probe(f"302 {self.ISSUER}/")
        self.assertEqual(code, 1, output)
        self.assertIn("302 to somewhere other than the Access login page", output)

    def test_other_hosts_and_look_alikes_fail(self):
        for location in (
            f"{self.ISSUER}/cdn-cgi/access/login/other.example.org?kid=abc",
            f"{self.ISSUER}/cdn-cgi/access/login/{self.HOST}.evil.example?kid=abc",
            f"{self.ISSUER}.evil.example/cdn-cgi/access/login/{self.HOST}",
            f"https://{self.HOST}/login",
        ):
            with self.subTest(location=location):
                code, output = self.probe(f"302 {location}")
                self.assertEqual(code, 1, output)
                self.assertIn(
                    "/: 302 to somewhere other than the Access login page", output
                )

    def test_an_answer_from_the_app_fails(self):
        for answer in ("200 ", "401 "):
            with self.subTest(answer=answer):
                code, output = self.probe(answer)
                self.assertEqual(code, 1, output)
                self.assertIn("was answered with", output)

    def test_no_connection_is_retried_then_fails(self):
        code, output = self.probe("000 ")
        self.assertEqual(code, 1, output)
        self.assertIn("/ never reached Access", output)


class LinksWorkerProbe(unittest.TestCase):
    """Links deploy's check of the host's anonymous half, run as the workflow runs it against a stubbed curl.

    Only /_ and /_/* are behind the path-scoped Access app "links"; /robots.txt and every short link reach the Worker
    anonymously. The step passes only when the Worker itself answers: its robots.txt (200, text/plain, its exact text)
    and, for a key no link uses, the 302 to this host's /_/k/<key>, both no-store and noindex."""

    STEP = "- name: Check that the Worker answers short links without Access\n"
    ISSUER = "https://example.cloudflareaccess.com"
    HOST = "s.example.org"
    ROBOTS = "User-agent: *\nDisallow: /\n"
    KEY = "/some-unknown-key"

    def good(self):
        """The Worker's answers (code, media type, redirect URL, Cache-Control, X-Robots-Tag, body) by path."""
        return {
            "/robots.txt": [
                "200",
                "text/plain; charset=utf-8",
                "",
                "private, no-store",
                "noindex",
                self.ROBOTS,
            ],
            self.KEY: [
                "302",
                "",
                f"https://{self.HOST}/_/k{self.KEY}",
                "private, no-store",
                "noindex",
                "",
            ],
        }

    def script(self):
        block = workflow_jobs()["links-deploy"]
        body = block.split(self.STEP, 1)[1].split("        run: |\n", 1)[1]
        lines = []
        for line in body.splitlines():
            if line.strip() and not line.startswith("          "):
                break
            lines.append(line[10:])
        return "\n".join(lines) + "\n"

    def check(self, answers, host=HOST):
        """Runs the step; curl answers each URL with answers[path] (one answer, or a list whose last item repeats),
        writes the body to its -o file and prints the -w fields joined by "|". Returns (exit code, output, URLs)."""
        with tempfile.TemporaryDirectory() as root:
            bin_dir = Path(root, "bin")
            bin_dir.mkdir()
            queues = {
                path: (answer if isinstance(answer[0], list) else [answer])
                for path, answer in answers.items()
            }
            Path(root, "answers.json").write_text(
                json.dumps(
                    {f"https://{host}{path}": queue for path, queue in queues.items()}
                )
            )
            curl = bin_dir / "curl"
            curl.write_text(
                f"#!{sys.executable}\n"
                "import json, sys\n"
                f"root = {root!r}\n"
                "args = sys.argv[1:]\n"
                "url = args[-1]\n"
                "open(root + '/urls', 'a').write(url + '\\n')\n"
                "table = json.load(open(root + '/answers.json'))\n"
                "queue = table.get(url, [['404', 'text/plain', '', 'private, no-store', 'noindex', 'Not found.']])\n"
                "answer = queue.pop(0) if len(queue) > 1 else queue[0]\n"
                "json.dump(table, open(root + '/answers.json', 'w'))\n"
                "open(args[args.index('-o') + 1], 'w').write(answer[5])\n"
                "sys.stdout.write('|'.join(answer[:5]))\n"
            )
            (bin_dir / "sleep").write_text("#!/usr/bin/env bash\nexit 0\n")
            for tool in (curl, bin_dir / "sleep"):
                tool.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                "ACCESS_ISSUER": self.ISSUER,
                "PUBLIC_HOST": host,
                "RUNNER_TEMP": root,
            }
            result = subprocess.run(
                ["bash", "-e", "-c", self.script()],
                cwd=REPO,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            urls = (
                Path(root, "urls").read_text().splitlines()
                if Path(root, "urls").exists()
                else []
            )
            return result.returncode, result.stdout + result.stderr, urls

    def test_the_workers_own_answers_pass(self):
        code, output, urls = self.check(self.good())
        self.assertEqual(code, 0, output)
        self.assertEqual(
            urls, [f"https://{self.HOST}/robots.txt", f"https://{self.HOST}{self.KEY}"]
        )
        self.assertIn("/robots.txt: 200 text/plain from the Worker", output)
        self.assertIn(f"{self.KEY}: 302 (no body) from the Worker", output)

    def test_the_probe_asks_curl_for_exactly_the_fields_it_reads(self):
        script = self.script()
        self.assertIn(
            "-w '%{http_code}|%{content_type}|%{redirect_url}|%header{cache-control}|%header{x-robots-tag}'",
            script,
        )
        self.assertIn("--proto '=https'", script)
        self.assertNotRegex(script, r"(?<!\S)(-L|--location)(?!\S)")

    def test_the_probed_answers_are_the_workers(self):
        """The robots text is the Worker's ROBOTS_TXT, and the probed key is a valid key that is not reserved, so the
        Worker answers it on the short-link path (an unknown key: the enumeration answer)."""
        pages = (REPO / "links" / "worker" / "src" / "pages.ts").read_text()
        self.assertIn(
            "export const ROBOTS_TXT = 'User-agent: *\\nDisallow: /\\n'", pages
        )
        self.assertIn("printf 'User-agent: *\\nDisallow: /\\n'", self.script())
        key = self.KEY[1:]
        self.assertRegex(key, r"^[a-z0-9][a-z0-9-]{0,62}$")
        limits = (REPO / "links" / "worker" / "src" / "limits.ts").read_text()
        self.assertNotIn(
            f"'{key}'", limits.split("RESERVED_KEYS", 1)[1].split("\n", 1)[0]
        )
        self.assertIn(f"'{self.KEY} 302'", self.script())

    def test_an_access_login_instead_of_the_worker_fails(self):
        login = [
            "302",
            "",
            f"{self.ISSUER}/cdn-cgi/access/login/{self.HOST}?kid=abc",
            "",
            "",
            "",
        ]
        for path in ("/robots.txt", self.KEY):
            with self.subTest(path=path):
                code, output, _ = self.check({**self.good(), path: login})
                self.assertEqual(code, 1, output)
                self.assertIn("the Access app links covers more than /_/*", output)

    def test_another_robots_text_or_media_type_fails(self):
        for change in (
            {5: "User-agent: *\nAllow: /\n"},
            {5: ""},
            {1: "text/html; charset=utf-8"},
            {1: ""},
        ):
            answer = self.good()["/robots.txt"]
            for index, value in change.items():
                answer[index] = value
            with self.subTest(change=change):
                code, output, _ = self.check({**self.good(), "/robots.txt": answer})
                self.assertEqual(code, 1, output)
                self.assertIn("is not the Worker's robots.txt", output)

    def test_a_cacheable_or_indexable_answer_fails(self):
        for path in ("/robots.txt", self.KEY):
            for index, value in (
                (3, "public, max-age=60"),
                (3, ""),
                (4, ""),
                (4, "all"),
            ):
                answer = self.good()[path]
                answer[index] = value
                with self.subTest(path=path, index=index, value=value):
                    code, output, _ = self.check({**self.good(), path: answer})
                    self.assertEqual(code, 1, output)
                    self.assertIn(
                        "without Cache-Control no-store and X-Robots-Tag noindex",
                        output,
                    )

    def test_another_status_or_redirect_fails(self):
        for path, index, value, message in (
            ("/robots.txt", 0, "404", "was answered with 404"),
            (self.KEY, 0, "404", "was answered with 404"),
            (self.KEY, 0, "301", "was answered with 301"),
            (self.KEY, 2, f"https://{self.HOST}/_/", "302 to somewhere other than"),
            (
                self.KEY,
                2,
                f"https://other.example.org/_/k{self.KEY}",
                "302 to somewhere other than",
            ),
            (self.KEY, 2, "https://example.com/", "302 to somewhere other than"),
        ):
            answer = self.good()[path]
            answer[index] = value
            with self.subTest(path=path, value=value):
                code, output, _ = self.check({**self.good(), path: answer})
                self.assertEqual(code, 1, output)
                self.assertIn(message, output)

    def test_no_connection_or_5xx_is_retried_then_fails(self):
        gone = ["000", "", "", "", "", ""]
        busy = ["503", "text/html", "", "", "", "busy"]
        code, output, _ = self.check(
            {**self.good(), "/robots.txt": [gone, busy, self.good()["/robots.txt"]]}
        )
        self.assertEqual(code, 0, output)
        self.assertIn("(attempt 3)", output)
        code, output, urls = self.check({**self.good(), self.KEY: gone})
        self.assertEqual(code, 1, output)
        self.assertIn(f"{self.KEY} never reached the Worker", output)
        self.assertEqual(len(urls), 11)

    def test_the_host_and_issuer_come_from_the_committed_config_after_the_access_probe(
        self,
    ):
        block = workflow_jobs()["links-deploy"]
        step = block.split(self.STEP, 1)[1].split("\n      - ", 1)[0]
        self.assertIn("PUBLIC_HOST: ${{ steps.config.outputs.host }}", step)
        self.assertIn("ACCESS_ISSUER: ${{ steps.config.outputs.access_issuer }}", step)
        self.assertLess(
            block.index("- name: Check that Access answers unauthenticated requests\n"),
            block.index(self.STEP),
        )
        code, _, urls = self.check(self.good(), host="")
        self.assertNotEqual(code, 0)
        self.assertEqual(urls, [])


class LinksProductionCheck(unittest.TestCase):
    """Links deploy's hostname-free check, run as the workflow runs it against a stubbed npx (wrangler). Nothing
    anonymous on the host shows the build, so the deployed version's BUILD_SHA tells whether this commit serves.

    It passes only when the live deployment serves one version at 100% whose BUILD_SHA is this commit and no D1
    migration is pending, and it never prints wrangler's JSON (it names the token's account email)."""

    JOB = "links-deploy"
    WORKER = "links"
    STEP = "- name: Check that production runs this commit\n"
    VERSION = "0b9c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3"
    EMAIL = "deployer@example.org"

    def script(self):
        return workflow_run_step(self.JOB, "Check that production runs this commit")[0]

    def deployment(self, *versions):
        return {
            "id": "synthetic",
            "author_email": self.EMAIL,
            "versions": [
                {"version_id": v, "percentage": share} for v, share in versions
            ]
            or [],
        }

    def version(self, build):
        bindings = [
            {"name": "DB", "type": "d1", "id": "synthetic"},
            {"name": "ACCESS_OWNER", "type": "secret_text"},
        ]
        if build is not None:
            bindings.append({"name": "BUILD_SHA", "type": "plain_text", "text": build})
        return {
            "id": self.VERSION,
            "metadata": {"author_email": self.EMAIL},
            "resources": {"bindings": bindings},
        }

    def check(
        self,
        deployment,
        version,
        migrations="\u2705 No migrations to apply!",
        token="synthetic-token",
        fail="",
        build_source="",
    ):
        """Runs the step; the stub answers `deployments status`, `versions view` and `d1 migrations list`, or exits 1
        for the command named in `fail`. Returns (exit code, output, the commands npx was asked to run)."""
        if shutil.which("jq") is None and os.environ.get("GITHUB_ACTIONS") != "true":
            self.skipTest("needs jq (the runner has it)")
        with tempfile.TemporaryDirectory() as root:
            workspace = Path(root, "workspace with spaces")
            workspace.symlink_to(REPO, target_is_directory=True)
            bin_dir = Path(root, "bin")
            bin_dir.mkdir()
            Path(root, "deployment.json").write_text(json.dumps(deployment))
            Path(root, "version.json").write_text(json.dumps(version))
            Path(root, "migrations.txt").write_text(migrations + "\n")
            npx = bin_dir / "npx"
            npx.write_text(
                "#!/usr/bin/env bash\n"
                # Wrangler and its relative config resolve in the app's installed worker directory.
                "test -f ../wrangler.toml || exit 4\n"
                f'echo "$*" >> "{root}/calls"\n'
                'args=" $* "\n'
                + (f'case "$args" in *" {fail} "*) exit 1 ;; esac\n' if fail else "")
                + 'case "$args" in\n'
                f'  *" deployments status "*) cat "{root}/deployment.json" ;;\n'
                f'  *" versions view {self.VERSION} "*) cat "{root}/version.json" ;;\n'
                f'  *" d1 migrations list DB --remote "*) cat "{root}/migrations.txt" ;;\n'
                '  *) echo "unexpected npx call" >&2; exit 3 ;;\n'
                "esac\n"
            )
            npx.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                "CLOUDFLARE_API_TOKEN": token,
                "GITHUB_SHA": SHA,
                "BUILD_SOURCE_SHA": build_source,
                "GITHUB_WORKSPACE": str(workspace),
            }
            script, directory = workflow_run_step(
                self.JOB, "Check that production runs this commit"
            )
            self.assertEqual(directory, Path(self.WORKER) / "worker")
            result = subprocess.run(
                ["bash", "-e", "-c", script],
                cwd=workspace / directory,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            calls = (
                Path(root, "calls").read_text().splitlines()
                if Path(root, "calls").exists()
                else []
            )
            output = result.stdout + result.stderr
            self.assertNotIn(self.EMAIL, output)
            return result.returncode, output, calls

    def test_this_commit_at_100_percent_with_no_pending_migration_passes(self):
        code, output, calls = self.check(
            self.deployment((self.VERSION, 100)), self.version(SHA)
        )
        self.assertEqual(code, 0, output)
        self.assertIn(
            f"The Worker {self.WORKER} serves version {self.VERSION} at 100%, built from {SHA}",
            output,
        )
        self.assertIn("No D1 migration is pending.", output)
        self.assertEqual(
            calls,
            [
                "--no-install wrangler deployments status --json --config ../wrangler.toml",
                f"--no-install wrangler versions view {self.VERSION} --json --config ../wrangler.toml",
                "--no-install wrangler d1 migrations list DB --remote --config ../wrangler.toml",
            ],
        )

    def test_another_build_or_none_fails(self):
        for build in ("c" * 40, "", None):
            with self.subTest(build=build):
                code, output, _ = self.check(
                    self.deployment((self.VERSION, 100)), self.version(build)
                )
                self.assertEqual(code, 1, output)
                self.assertIn(f"was not built from {SHA}", output)
                if build:
                    self.assertNotIn(build, output)

    def test_repair_build_source_is_verified_and_reported(self):
        repaired_sha = "d" * 40
        code, output, _ = self.check(
            self.deployment((self.VERSION, 100)),
            self.version(repaired_sha),
            build_source=repaired_sha,
        )
        self.assertEqual(code, 0, output)
        self.assertIn(f"built from {repaired_sha}", output)
        self.assertNotIn(SHA, output)

    def test_repair_mismatch_reports_expected_build_source(self):
        repaired_sha = "d" * 40
        code, output, _ = self.check(
            self.deployment((self.VERSION, 100)),
            self.version(SHA),
            build_source=repaired_sha,
        )
        self.assertEqual(code, 1, output)
        self.assertIn(f"was not built from {repaired_sha}", output)
        self.assertNotIn(SHA, output)

    def test_a_split_or_empty_deployment_fails(self):
        for versions in (
            ((self.VERSION, 50), ("1" * 8 + "-0000-4000-8000-" + "1" * 12, 50)),
            ((self.VERSION, 90),),
            (),
        ):
            with self.subTest(versions=versions):
                code, output, calls = self.check(
                    self.deployment(*versions), self.version(SHA)
                )
                self.assertEqual(code, 1, output)
                self.assertIn("does not serve exactly one version at 100%", output)
                self.assertEqual(len(calls), 1)

    def test_a_pending_migration_fails(self):
        pending = "Migrations to be applied:\n| Name |\n| 0004_next.sql |"
        code, output, _ = self.check(
            self.deployment((self.VERSION, 100)), self.version(SHA), migrations=pending
        )
        self.assertEqual(code, 1, output)
        self.assertIn("D1 migrations are still pending.", output)

    def test_a_failed_read_or_a_missing_token_fails(self):
        for fail, message in (
            ("deployments", "Could not read the deployment"),
            ("view", "Could not read the deployed version"),
            ("list", "Could not list the D1 migrations"),
        ):
            with self.subTest(fail=fail):
                code, output, _ = self.check(
                    self.deployment((self.VERSION, 100)), self.version(SHA), fail=fail
                )
                self.assertEqual(code, 1, output)
                self.assertIn(message, output)
        code, output, calls = self.check(
            self.deployment((self.VERSION, 100)), self.version(SHA), token=""
        )
        self.assertNotEqual(code, 0, output)
        self.assertEqual(calls, [])


class WatchProductionCheck(LinksProductionCheck):
    """Watch deploy's check: the same step without the D1 part (the watch app has no D1). Nothing anonymous on the host
    shows the build (it is all behind Access), so the deployed version's BUILD_SHA tells whether this commit serves."""

    JOB = "watch-deploy"
    WORKER = "watch"

    def test_the_same_step_as_the_links_app_without_d1(self):
        links = LinksProductionCheck.script(LinksProductionCheck())
        self.assertEqual(
            self.script(),
            links.replace('production.sh" links', 'production.sh" watch').replace(
                "wrangler.toml DB", "wrangler.toml"
            ),
        )
        self.assertNotIn(" DB", self.script())

    def test_this_commit_at_100_percent_with_no_pending_migration_passes(self):
        code, output, calls = self.check(
            self.deployment((self.VERSION, 100)), self.version(SHA)
        )
        self.assertEqual(code, 0, output)
        self.assertIn(
            f"The Worker {self.WORKER} serves version {self.VERSION} at 100%, built from {SHA}",
            output,
        )
        self.assertNotIn("migration", output)
        self.assertEqual(
            calls,
            [
                "--no-install wrangler deployments status --json --config ../wrangler.toml",
                f"--no-install wrangler versions view {self.VERSION} --json --config ../wrangler.toml",
            ],
        )

    def test_a_pending_migration_fails(self):
        self.skipTest("the watch app has no D1 database")

    def test_a_failed_read_or_a_missing_token_fails(self):
        for fail, message in (
            ("deployments", "Could not read the deployment"),
            ("view", "Could not read the deployed version"),
        ):
            with self.subTest(fail=fail):
                code, output, _ = self.check(
                    self.deployment((self.VERSION, 100)), self.version(SHA), fail=fail
                )
                self.assertEqual(code, 1, output)
                self.assertIn(message, output)
        code, output, calls = self.check(
            self.deployment((self.VERSION, 100)), self.version(SHA), token=""
        )
        self.assertNotEqual(code, 0, output)
        self.assertEqual(calls, [])


class HostnameGuard(unittest.TestCase):
    """Every deploy that applies a wrangler.toml with Custom Domains or zone routes runs tools/cf-guard on that
    config, with the job's own token, before the first production change (D1 migrations or wrangler deploy)."""

    GUARD = "node tools/cf-guard/cf-guard.mjs"
    STEP = "- name: Check the hostnames against production\n"
    # Intentional hostname changes, (CF_GUARD_ALLOW_REMOVE, CF_GUARD_ALLOW_CONFLICT) per job, set only in the commit
    # that makes them (a cutover onto a hostname sets both for its deploy; the next commit clears them). None today.
    # A conflict allowance names its kind: "dns:<host>", "worker:<host>" or "route:<pattern>" (tools/cf-guard).
    ALLOWED: ClassVar[dict[str, tuple[str, str]]] = {}

    @staticmethod
    def has_routes(config):
        import tomllib

        with open(REPO / config, "rb") as handle:
            data = tomllib.load(handle)
        return bool(data.get("routes") or data.get("route"))

    def test_each_deploy_guards_its_configs_before_changing_production(self):
        blocks = workflow_jobs()
        for job, configs, token, first_change in (
            (
                "todofy-deploy",
                ["todofy/wrangler.toml", "todofy/gateway/wrangler.toml"],
                "CF_API_TOKEN",
                "wrangler d1 migrations apply",
            ),
            (
                "mail-hero-deploy",
                ["mail-hero/wrangler.toml"],
                "MAIL_HERO_CF_API_TOKEN",
                "wrangler d1 migrations apply",
            ),
            (
                "dashboard-deploy",
                ["dashboard/wrangler.toml"],
                "CF_API_TOKEN",
                'deploy-vars.mjs exec -- npx --no-install wrangler deploy "$PWD/../.compiled/worker/index.js" --no-bundle --config',
            ),
            (
                "links-deploy",
                ["links/wrangler.toml"],
                "CF_API_TOKEN",
                "wrangler d1 migrations apply",
            ),
            (
                "watch-deploy",
                ["watch/wrangler.toml"],
                "CF_API_TOKEN",
                'deploy-vars.mjs exec -- npx --no-install wrangler deploy "$PWD/../.compiled/worker/index.js" --no-bundle --config',
            ),
            (
                "fleet-deploy",
                ["fleet/wrangler.toml"],
                "CF_API_TOKEN",
                'deploy-vars.mjs exec -- npx --no-install wrangler deploy "$PWD/../.compiled/worker/index.js" --no-bundle --config',
            ),
        ):
            block = blocks[job]
            with self.subTest(job=job):
                self.assertEqual(block.count(self.STEP), 1)
                step = block.split(self.STEP, 1)[1].split("\n      - ", 1)[0]
                self.assertIn("        working-directory: .\n", step)
                self.assertIn(f"CLOUDFLARE_API_TOKEN: ${{{{ secrets.{token} }}}}", step)
                remove, conflict = (
                    value or "''" for value in self.ALLOWED.get(job, ("", ""))
                )
                self.assertIn(f"CF_GUARD_ALLOW_REMOVE: {remove}\n", step)
                self.assertIn(f"CF_GUARD_ALLOW_CONFLICT: {conflict}\n", step)
                self.assertIn(
                    self.GUARD
                    + "".join(f" --config {config}" for config in configs)
                    + "\n",
                    step + "\n",
                )
                self.assertLess(block.index(self.STEP), block.index(first_change))
                self.assertTrue(any(self.has_routes(config) for config in configs))

    def test_every_production_config_with_routes_is_guarded(self):
        text = effective_ci()
        release = (REPO / ".github" / "workflows" / "website-release.yml").read_text()
        for config in sorted(source_files("*/**/wrangler.toml")):
            relative = config.relative_to(REPO).as_posix()
            if "node_modules" in relative or not self.has_routes(relative):
                continue
            with self.subTest(config=relative):
                if relative == "website/wrangler.toml":
                    # The site release runs the guard through `pnpm release hostnames` and inside `deploy`.
                    self.assertIn("\n        run: pnpm release hostnames\n", release)
                else:
                    self.assertIn(f"--config {relative}", text)

    def test_the_website_release_guards_before_the_upload_and_the_deploy(self):
        release = (REPO / ".github" / "workflows" / "website-release.yml").read_text()
        guard = release.index(
            "- name: Check the wrangler.toml hostnames against production\n"
        )
        self.assertLess(
            guard,
            release.index("- name: Upload the verified export as a Worker version\n"),
        )
        step = release[guard:].split("\n      - ", 1)[0]
        self.assertIn("if: steps.decision.outputs.deploy_required == 'true'", step)
        self.assertIn("CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}", step)
        deploy = release[
            release.index(
                "- name: Deploy the version and the wrangler.toml hostnames\n"
            ) :
        ].split("\n      - ", 1)[0]
        self.assertRegex(deploy, r"CF_GUARD_ALLOW_REMOVE: (?P<quote>[\"\'])\1")
        steps = (REPO / "website" / "scripts" / "release" / "steps.ts").read_text()
        self.assertLess(
            steps.index("await deps.hostnames.check()"),
            steps.index("await deps.wrangler.deployTriggers()"),
        )
        cloudflare = (
            REPO / "website" / "scripts" / "release" / "cloudflare.ts"
        ).read_text()
        self.assertIn(
            'path.resolve(cwd, "..", "tools", "cf-guard", "cf-guard.mjs")', cloudflare
        )

    def test_the_hostname_guard_is_a_registered_bazel_check(self):
        planner = (REPO / "tools/bazel/ci/plan.py").read_text()
        self.assertIn('filter(":check$", //...)', planner)
        build = (REPO / "tools/cf-guard/BUILD.bazel").read_text()
        self.assertIn('name = "check"', build)

    def test_website_release_uses_the_same_declared_verification_browser(self):
        text = (REPO / ".github/workflows/website-release.yml").read_text()
        self.assertIn("bazel run //tools/bazel/browser:install_chromium_dependencies", text)
        manifest = json.loads((REPO / "website/package.json").read_text())
        self.assertEqual(manifest["scripts"]["test:deployment"], "bazel run //website:verify_deployment")
        self.assertNotIn("playwright install --with-deps", text)



if __name__ == "__main__":
    unittest.main()
