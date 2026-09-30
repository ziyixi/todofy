"""Checks across the apps' Wrangler configs and ci.yml: python3 -m unittest discover -s .github/scripts

Needs Python 3.11+ (tomllib), as CI's ubuntu-24.04 python3 (3.12) has. With an older python3 (macOS ships
3.9) this module is skipped with a message, and the other script tests still run; run all of them with
    uv run --no-project --python 3.12 python -m unittest discover -s .github/scripts
Under GitHub Actions a missing tomllib is an error, never a skip.

Every Worker's production config is one committed file named wrangler.toml in the folder that names the
Worker, and its top level is production (no [env.*], no keep_vars). What is never committed (personal values,
operational switches, the build) is added at deploy by each app's deploy-vars wrapper, which refuses a missing
value; these tests keep ci.yml, the wrappers and the configs in step. They read other apps' folders, which is
why they live here and not in any app (root AGENTS.md). Standard library only.
"""

import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        raise
    raise unittest.SkipTest(
        f"test_wrangler_configs needs Python 3.11+ (tomllib), this is {sys.version.split()[0]}: "
        "uv run --no-project --python 3.12 python -m unittest discover -s .github/scripts"
    ) from None

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
    "ziyixi-apex-redirect": "website/apex-redirect/wrangler.toml",
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


# wrangler options that take a value (the value may be the next token): skipped to find the command.
WRANGLER_VALUE_OPTIONS = {"-c", "--config", "-e", "--env", "--cwd", "--env-file"}


def wrangler_commands(line: str) -> list[str]:
    """The command of each wrangler call on a shell line ("deploy", "versions upload", "d1", ...), found by
    skipping global options before it: `wrangler --config x deploy`, `wrangler@4.141.0 deploy`, `pywrangler
    -c x deploy` all name "deploy"."""
    found = []
    tokens = line.replace("\\\n", " ").split()
    for index, token in enumerate(tokens):
        if not re.fullmatch(r"(?:\S*/)?(?:py)?wrangler(?:@\S+)?", token):
            continue
        rest = tokens[index + 1 :]
        position = 0
        while position < len(rest) and rest[position].startswith("-"):
            option = rest[position]
            position += 2 if option in WRANGLER_VALUE_OPTIONS else 1
        if position < len(rest):
            command = rest[position]
            if command == "versions" and position + 1 < len(rest):
                command = f"versions {rest[position + 1]}"
            found.append(command)
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


class LocalDev(unittest.TestCase):
    """`wrangler dev` takes a config's first route as every local request's URL unless --local-upstream (or
    --host) names the origin. With the production routes committed, a bare dev command would make the Worker
    see its production host: the loopback / *.localhost DEV_AUTH_BYPASS then refuses (Mail Hero, dashboard)
    and the gateway's host routing matches no local host. Every documented or scripted `wrangler dev` of a
    production config therefore pins the origin. The website is left out: its Worker has no code that reads
    the request URL (static assets only). Markdown table rows are records of past experiments, not commands."""

    DEV = re.compile(r"\b(?:py)?wrangler(?:@\S+)?\s+dev\b")
    PRODUCTION_CONFIG = re.compile(r"(?:-c|--config)[ =](?:\.\./)?(?:gateway/)?wrangler\.toml\b")

    def commands(self):
        """(path, command) for each `wrangler dev` line of a production config, backslash continuations joined."""
        found = []
        for path in tracked_files():
            if path.startswith("website/") or "node_modules/" in path or path.endswith("package-lock.json"):
                continue
            if not re.search(r"\.(md|json|ts|mjs|toml|py|sh|yml|example)$", path):
                continue
            try:
                text = (REPO / path).read_text()
            except (OSError, UnicodeDecodeError):
                continue
            for line in re.sub(r"\\\n\s*#?", " ", text).splitlines():
                if line.lstrip().startswith("|"):
                    continue
                if self.DEV.search(line) and self.PRODUCTION_CONFIG.search(line):
                    found.append((path, line.strip()))
        return found

    def test_the_production_configs_with_routes_are_the_ones_dev_runs(self):
        for worker in ("mail-hero", "todofy", "home"):
            with self.subTest(worker=worker):
                self.assertTrue(load(PRODUCTION[worker]).get("routes"))

    def test_every_dev_command_of_a_production_config_pins_its_origin(self):
        commands = self.commands()
        paths = {path for path, _ in commands}
        # The scripted and documented entry points of each app are all found (the scan still sees them).
        self.assertLessEqual(
            {"mail-hero/cloudflare/package.json", "dashboard/worker/package.json", "todofy/docs/dev-notes.md"}, paths
        )
        for path, command in commands:
            with self.subTest(path=path, command=command):
                self.assertRegex(command, r"--local-upstream[ =]\S+|--host[ =]\S+")
                self.assertNotIn("--remote", command)


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
                        if {"deploy", "versions upload"} & set(wrangler_commands(line)):
                            with self.subTest(job=job_name, line=line.strip()):
                                self.assertRegex(line, r"deploy[-_]vars\.(mjs|py) exec( core| gateway)? -- ")
                                self.assertNotRegex(line, r"--env\b|--keep-vars|--var\b|wrangler\.production")

    def test_the_deploy_detector_sees_every_spelling(self):
        for line in (
            "npx --no-install wrangler deploy --config ../wrangler.toml",
            "npx --no-install wrangler --config ../wrangler.toml deploy",
            "wrangler -c ../wrangler.toml deploy",
            "npm exec -- wrangler@4.141.0 deploy --config=../wrangler.toml",
            "node_modules/.bin/wrangler --env-file x versions upload",
            "uv run pywrangler deploy --config wrangler.toml",
            "uv run pywrangler --config wrangler.toml deploy",
        ):
            with self.subTest(line=line):
                self.assertTrue({"deploy", "versions upload"} & set(wrangler_commands(line)))
        for line in (
            "npx --no-install wrangler d1 migrations apply DB --remote --config ../wrangler.toml",
            "npx --no-install wrangler --config ../wrangler.toml versions list",
            "echo wrangler.toml deploy",
        ):
            with self.subTest(line=line):
                self.assertFalse({"deploy", "versions upload"} & set(wrangler_commands(line)))

    def test_deploy_jobs_restate_every_switch_from_its_variable(self):
        """A deploy step that set a switch to a literal would overwrite the live pause or maintenance state:
        in the deploy jobs each switch a step sets comes exactly from its GitHub variable."""
        seen = set()
        for job_name in DEPLOY_JOBS:
            for step in steps(self.jobs[job_name]):
                for name in TOGGLES & set(step["env"]):
                    seen.add(name)
                    with self.subTest(job=job_name, step=step["name"], name=name):
                        self.assertEqual(step["env"][name], f"${{{{ vars.{name} }}}}")
        self.assertEqual(seen, TOGGLES)

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
