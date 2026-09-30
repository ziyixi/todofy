"""Checks across the apps' Wrangler configs and ci.yml: python3 -m unittest discover -s .github/scripts

Every Worker's production config is one committed file named wrangler.toml in the folder that names the
Worker, and its top level is production (no [env.*], no keep_vars). What is never committed (personal values,
operational switches, the build) is added at deploy by each app's deploy-vars wrapper, which refuses a missing
value; these tests keep ci.yml, the wrappers and the configs in step. They read other apps' folders, which is
why they live here and not in any app (root AGENTS.md). Standard library only.
"""

import re
import subprocess
import tomllib
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "ci.yml"

# Worker name -> its production config.
PRODUCTION = {
    "mail-hero": "mail-hero/wrangler.toml",
    "todofy-core": "todofy/wrangler.toml",
    "todofy": "todofy/gateway/wrangler.toml",
    "home": "dashboard/wrangler.toml",
    "ziyixi-website": "website/wrangler.toml",
    "ziyixi-notion-publish": "website/relay/wrangler.toml",
}
# Runtime-test configs stay next to their tests.
TEST_CONFIGS = {
    "todofy/wrangler.test.toml",
    "todofy/gateway/wrangler.test.toml",
    "todofy/gateway/wrangler.test-auth.toml",
}

# Each app with a deploy-vars wrapper: the wrapper, how CI calls it, and its production configs.
WRAPPERS = {
    "mail-hero": ("mail-hero/deploy/deploy-vars.mjs", r"deploy-vars\.mjs (exec|secrets)\b", ["mail-hero"]),
    "todofy": (
        "todofy/deploy/deploy_vars.py",
        r"deploy_vars\.py (exec core|exec gateway|secrets)\b",
        ["todofy-core", "todofy"],
    ),
    "dashboard": ("dashboard/deploy/deploy-vars.mjs", r"deploy-vars\.mjs (exec|secrets)\b", ["home"]),
}
# Worker vars that must never be committed: personal values (GitHub environment secrets) ...
PERSONAL_VARS = {"RECEIVE_ADDRESS", "ACCESS_OWNER", "ACCESS_OWNER_ALIASES", "TODOIST_DEFAULT_PROJECT_ID"}
# ... and the GitHub names they come from. In ci.yml they are only ever secrets (or checks' placeholders).
PERSONAL_INPUTS = {
    "MAIL_HERO_RECEIVE_ADDRESS",
    "MAIL_HERO_ACCESS_OWNER",
    "MAIL_HERO_ACCESS_OWNER_ALIASES",
    "TODOFY_TODOIST_DEFAULT_PROJECT_ID",
    "TODOFY_ACCESS_OWNER",
    "TODOFY_ACCESS_OWNER_ALIASES",
    "DASHBOARD_ACCESS_OWNER",
    "DASHBOARD_ACCESS_OWNER_ALIASES",
}
# The only GitHub variables CI reads: the operational switches, stated at every deploy (mail-hero AGENTS.md §8).
TOGGLES = {
    "MAIL_HERO_FORCE_SEND_PAUSED",
    "MAIL_HERO_MAINTENANCE_MODE",
    "TODOFY_MAINTENANCE_MODE",
    "TODOFY_PROCESSING_PAUSED",
    "TODOFY_FORCE_PAUSE_TODOIST",
    "TODOFY_REMINDER_ENABLED",
    "DASHBOARD_CANARY_ENABLED",
}
DEPLOY_JOBS = ("todofy-deploy", "mail-hero-deploy", "dashboard-deploy")


def load(path: str) -> dict:
    return tomllib.loads((REPO / path).read_text())


def uncommented(path: str) -> str:
    return "\n".join(line for line in (REPO / path).read_text().splitlines() if not line.lstrip().startswith("#"))


def tracked_files() -> list[str]:
    try:
        output = subprocess.run(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd=REPO,
            capture_output=True,
            check=True,
            text=True,
        ).stdout
        return [path for path in output.split("\0") if path]
    except (OSError, subprocess.CalledProcessError):
        return [path.relative_to(REPO).as_posix() for path in REPO.rglob("*") if path.is_file()]


def markers(wrapper: str) -> dict[str, list[str]]:
    """The wrapper's `deploy-vars-inputs <mode>: NAMES` lines, by mode (a mode may take several lines)."""
    found: dict[str, list[str]] = {}
    for mode, names in re.findall(r"^(?:#|//) deploy-vars-inputs (\w+): (.+)$", (REPO / wrapper).read_text(), re.M):
        found.setdefault(mode, []).extend(names.split())
    return found


def workflow_jobs() -> dict[str, str]:
    text = WORKFLOW.read_text()
    body = text.split("\njobs:\n", 1)[1]
    parts = re.split(r"^  ([a-z0-9-]+):\n", body, flags=re.M)
    return dict(zip(parts[1::2], parts[2::2], strict=True))


def steps(job: str) -> list[dict]:
    """Each step of a job: its name, env (NAME -> raw value) and run script."""
    found = []
    for chunk in re.split(r"^      - ", job, flags=re.M)[1:]:
        lines = ("      - " + chunk).splitlines()
        step = {"name": "", "env": {}, "run": "", "working-directory": ""}
        index = 0
        while index < len(lines):
            line = lines[index]
            key = re.match(r"^(?:      - |        )([a-z-]+):(.*)$", line)
            index += 1
            if not key:
                continue
            name, rest = key.group(1), key.group(2).strip()
            block = []
            while index < len(lines) and (lines[index].startswith("          ") or not lines[index].strip()):
                block.append(lines[index])
                index += 1
            if name == "name":
                step["name"] = rest
            elif name == "working-directory":
                step["working-directory"] = rest
            elif name == "env":
                for entry in block:
                    match = re.match(r"^          ([A-Z0-9_]+): ?(.*)$", entry)
                    if match:
                        step["env"][match.group(1)] = match.group(2).strip()
            elif name == "run":
                step["run"] = rest if rest not in ("|", ">") else "\n".join(entry[10:] for entry in block)
        found.append(step)
    return found


class Files(unittest.TestCase):
    def test_only_the_known_wrangler_configs_exist(self):
        """One wrangler.toml per Worker, in the folder that names it, plus the runtime-test configs. A stray
        config (a wrangler.json[c] anywhere, or one at the repo root) would win wrangler's walk-up discovery."""
        configs = {
            path
            for path in tracked_files()
            if re.fullmatch(r"wrangler[^/]*\.(toml|json|jsonc)", path.rsplit("/", 1)[-1])
            and "node_modules/" not in path
        }
        self.assertEqual(configs, set(PRODUCTION.values()) | TEST_CONFIGS)
        for path in PRODUCTION.values():
            self.assertEqual(path.rsplit("/", 1)[-1], "wrangler.toml", path)

    def test_every_config_is_top_level_only(self):
        for path in [*PRODUCTION.values(), *sorted(TEST_CONFIGS)]:
            with self.subTest(path=path):
                config = load(path)
                self.assertNotIn("env", config)
                self.assertNotIn("keep_vars", config)

    def test_the_production_configs_name_their_workers_on_one_account(self):
        accounts = set()
        for name, path in PRODUCTION.items():
            with self.subTest(path=path):
                config = load(path)
                self.assertEqual(config["name"], name)
                self.assertRegex(config["account_id"], r"^[a-f0-9]{32}$")
                accounts.add(config["account_id"])
                self.assertFalse([var for var in config.get("vars", {}) if var.startswith("DEV_")])
                self.assertIs(config.get("preview_urls"), False)
        self.assertEqual(len(accounts), 1)

    def test_no_personal_value_switch_or_build_is_committed(self):
        """Personal values, switches and the build come from the deploy only; no address is ever committed."""
        for app, (wrapper, _, workers) in WRAPPERS.items():
            injected_sources = {name for names in markers(wrapper).values() for name in names}
            self.assertTrue(injected_sources, app)
            for worker in workers:
                path = PRODUCTION[worker]
                with self.subTest(path=path):
                    names = set(load(path).get("vars", {}))
                    self.assertFalse(names & PERSONAL_VARS)
                    self.assertFalse(
                        names
                        & {
                            "BUILD_SHA",
                            "MAINTENANCE_MODE",
                            "FORCE_SEND_PAUSED",
                            "PROCESSING_PAUSED",
                            "FORCE_PAUSE_TODOIST",
                            "REMINDER_ENABLED",
                            "CANARY_ENABLED",
                        }
                    )
                    self.assertNotIn("@", uncommented(path))

    def test_cross_worker_bindings_name_existing_workers(self):
        gateway = load(PRODUCTION["todofy"])
        [binding] = gateway["durable_objects"]["bindings"]
        self.assertIn(binding["script_name"], PRODUCTION)
        self.assertEqual(binding["script_name"], "todofy-core")
        for service in load(PRODUCTION["home"])["services"]:
            with self.subTest(service=service["binding"]):
                self.assertIn(service["service"], PRODUCTION)
                self.assertEqual(service["entrypoint"], "Ops")


class Hosts(unittest.TestCase):
    """The dashboard's own host, the apps' hosts and the dashboard's links to the apps agree."""

    def setUp(self):
        self.mail_hero = load(PRODUCTION["mail-hero"])["vars"]["PUBLIC_HOST"]
        gateway = load(PRODUCTION["todofy"])["vars"]
        self.todofy = gateway["TODOFY_PUBLIC_HOST"]
        self.hooks = gateway["TODOFY_HOOKS_HOSTS"].split(",")
        self.home = load(PRODUCTION["home"])

    def test_every_custom_domain_belongs_to_one_worker(self):
        owners: dict[str, str] = {}
        for name, path in PRODUCTION.items():
            for route in load(path).get("routes", []):
                with self.subTest(host=route["pattern"]):
                    self.assertNotIn(route["pattern"], owners)
                    owners[route["pattern"]] = name

    def test_the_dashboard_host_is_its_own(self):
        host = self.home["vars"]["PUBLIC_HOST"]
        self.assertEqual(self.home["routes"], [{"pattern": host, "custom_domain": True}])
        self.assertNotIn(host, {self.mail_hero, self.todofy, *self.hooks})

    def test_the_core_links_to_the_gateway_host(self):
        self.assertEqual(load(PRODUCTION["todofy-core"])["vars"]["TODOFY_PUBLIC_HOST"], self.todofy)

    def test_the_dashboard_links_to_the_app_hosts(self):
        registry = (REPO / "dashboard" / "worker" / "src" / "registry.ts").read_text()
        urls = dict(re.findall(r"id: '(mail-hero|todofy)',[^}]*?url: '([^']+)'", registry, re.S))
        self.assertEqual(urls, {"mail-hero": f"https://{self.mail_hero}/", "todofy": f"https://{self.todofy}/"})


class Workflow(unittest.TestCase):
    def setUp(self):
        self.jobs = workflow_jobs()

    def app_jobs(self, app):
        return {name: block for name, block in self.jobs.items() if name.startswith(f"{app}-")}

    def test_every_wrapper_call_sets_every_input(self):
        """A missing --var deletes that var: each step that runs a wrapper declares each input of that call
        (GITHUB_* come from Actions itself), and each app's checks and deploy both call it."""
        for app, (wrapper, pattern, _) in WRAPPERS.items():
            inputs = markers(wrapper)
            calls = 0
            for job_name, job in self.app_jobs(app).items():
                for step in steps(job):
                    for call in re.findall(pattern, step["run"]):
                        # "exec" / "secrets" (Mail Hero, dashboard); "exec core" / "exec gateway" / "secrets" (Todofy).
                        mode = call.split()[-1]
                        needed = {name for name in inputs[mode] if not name.startswith("GITHUB_")}
                        calls += 1
                        with self.subTest(job=job_name, step=step["name"], call=call):
                            self.assertLessEqual(needed, set(step["env"]))
            self.assertGreaterEqual(calls, 2, app)

    def test_every_production_deploy_of_these_apps_runs_through_its_wrapper(self):
        for app in WRAPPERS:
            for job_name, job in self.app_jobs(app).items():
                for step in steps(job):
                    for line in step["run"].replace("\\\n", " ").splitlines():
                        if re.search(r"\b(?:py)?wrangler (deploy|versions upload)\b", line):
                            with self.subTest(job=job_name, line=line.strip()):
                                self.assertRegex(line, r"deploy[-_]vars\.(mjs|py) exec( core| gateway)? -- ")
                                self.assertNotRegex(line, r"--env\b|--keep-vars|--var\b|wrangler\.production")

    def test_github_variables_are_only_the_switches(self):
        used = set(re.findall(r"\bvars\.([A-Z0-9_]+)", WORKFLOW.read_text()))
        self.assertEqual(used, TOGGLES)

    def test_personal_values_come_only_from_secrets_or_placeholders(self):
        for job_name, job in self.jobs.items():
            for step in steps(job):
                for name in PERSONAL_INPUTS & set(step["env"]):
                    value = step["env"][name]
                    with self.subTest(job=job_name, step=step["name"], name=name):
                        if job_name in DEPLOY_JOBS:
                            self.assertEqual(value, f"${{{{ secrets.{name} }}}}")
                        else:
                            self.assertRegex(value, r"^(''|placeholder|[a-z.-]*@([a-z-]+\.)*example\.com)$")

    def test_deploy_jobs_pass_values_through_env_only(self):
        """No ${{ }} inside a deploy job's scripts (values reach them through env:), no account variable
        (account_id is committed), and only the environment's switches and secrets."""
        for job_name in DEPLOY_JOBS:
            job = self.jobs[job_name]
            self.assertNotIn("CLOUDFLARE_ACCOUNT_ID", job)
            self.assertIn("url: ${{ steps.config.outputs.url }}", job)
            for step in steps(job):
                with self.subTest(job=job_name, step=step["name"]):
                    self.assertNotIn("${{", step["run"])


if __name__ == "__main__":
    unittest.main()
