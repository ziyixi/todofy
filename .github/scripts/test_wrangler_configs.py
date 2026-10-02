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

sys.path.insert(0, str(Path(__file__).parent))
import ci_changes  # noqa: E402

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
    "lab": "lab/wrangler.toml",
    "flowday": "flowday/wrangler.toml",
    "links": "links/wrangler.toml",
    "watch": "watch/wrangler.toml",
}
# Configs of Workers that CI checks but does not deploy yet (no deploy job, no hostname, placeholder resource ids).
# They stay out of PRODUCTION, which the dashboard's drift check compares with the live account
# (drift_desired.py). FlowDay moved to PRODUCTION at F2 (flowday/docs/design.md section 11), the links app at L2
# (links/docs/design.md section 11) and the watch app at W2 (watch/docs/design.md section 11): empty.
UNDEPLOYED: dict[str, str] = {}
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
        r"deploy_vars\.py (exec core|exec gateway|secrets core|secrets gateway)\b",
        ["todofy-core", "todofy"],
    ),
    "dashboard": ("dashboard/deploy/deploy-vars.mjs", r"deploy-vars\.mjs (exec|secrets)\b", ["home"]),
    "lab": ("lab/deploy/deploy-vars.mjs", r"deploy-vars\.mjs (exec|secrets)\b", ["lab"]),
    "flowday": ("flowday/deploy/deploy-vars.mjs", r"deploy-vars\.mjs (exec|secrets)\b", ["flowday"]),
    "links": ("links/deploy/deploy-vars.mjs", r"deploy-vars\.mjs (exec|secrets)\b", ["links"]),
    "watch": ("watch/deploy/deploy-vars.mjs", r"deploy-vars\.mjs (exec|secrets)\b", ["watch"]),
}
# Worker vars that must never be committed: personal values (GitHub environment secrets) ...
PERSONAL_VARS = {
    "RECEIVE_ADDRESS",
    "ACCESS_OWNER",
    "ACCESS_OWNER_ALIASES",
    "TODOIST_DEFAULT_PROJECT_ID",
    "TODOIST_OPS_PROJECT_ID",
    "TODOIST_REVIEW_PROJECT_ID",
}
# ... and the GitHub names they come from. In ci.yml they are only ever secrets (or checks' placeholders).
PERSONAL_INPUTS = {
    "MAIL_HERO_RECEIVE_ADDRESS",
    "MAIL_HERO_ACCESS_OWNER",
    "MAIL_HERO_ACCESS_OWNER_ALIASES",
    "TODOFY_TODOIST_DEFAULT_PROJECT_ID",
    "TODOFY_TODOIST_OPS_PROJECT_ID",
    "TODOFY_TODOIST_REVIEW_PROJECT_ID",
    "TODOFY_ACCESS_OWNER",
    "TODOFY_ACCESS_OWNER_ALIASES",
    "DASHBOARD_ACCESS_OWNER",
    "DASHBOARD_ACCESS_OWNER_ALIASES",
    "LAB_ACCESS_OWNER",
    "LAB_ACCESS_OWNER_ALIASES",
    "FLOWDAY_ACCESS_OWNER",
    "FLOWDAY_ACCESS_OWNER_ALIASES",
    "LINKS_ACCESS_OWNER",
    "LINKS_ACCESS_OWNER_ALIASES",
    "WATCH_ACCESS_OWNER",
    "WATCH_ACCESS_OWNER_ALIASES",
}
# Personal inputs a deploy job reads from another app's secret: the owner of Lab, FlowDay, the links app and the watch
# app is the dashboard's owner (one person, the same Access identities), so their deploys read the dashboard's secrets
# (lab/README.md "Deploy secrets", flowday/README.md "Deploy", links/README.md "Deploy", watch/README.md "Deploy").
SHARED_SECRETS = {
    "LAB_ACCESS_OWNER": "DASHBOARD_ACCESS_OWNER",
    "LAB_ACCESS_OWNER_ALIASES": "DASHBOARD_ACCESS_OWNER_ALIASES",
    "FLOWDAY_ACCESS_OWNER": "DASHBOARD_ACCESS_OWNER",
    "FLOWDAY_ACCESS_OWNER_ALIASES": "DASHBOARD_ACCESS_OWNER_ALIASES",
    "LINKS_ACCESS_OWNER": "DASHBOARD_ACCESS_OWNER",
    "LINKS_ACCESS_OWNER_ALIASES": "DASHBOARD_ACCESS_OWNER_ALIASES",
    "WATCH_ACCESS_OWNER": "DASHBOARD_ACCESS_OWNER",
    "WATCH_ACCESS_OWNER_ALIASES": "DASHBOARD_ACCESS_OWNER_ALIASES",
}
# The only GitHub variables CI reads: the operational switches, stated at every deploy (mail-hero AGENTS.md §8).
TOGGLES = {
    "MAIL_HERO_FORCE_SEND_PAUSED",
    "MAIL_HERO_MAINTENANCE_MODE",
    "TODOFY_MAINTENANCE_MODE",
    "TODOFY_PROCESSING_PAUSED",
    "TODOFY_FORCE_PAUSE_TODOIST",
    "TODOFY_REMINDER_ENABLED",
    "TODOFY_GTD_REVIEW_ENABLED",
    "DASHBOARD_CANARY_ENABLED",
}
DEPLOY_JOBS = ("todofy-deploy", "mail-hero-deploy", "dashboard-deploy", "lab-deploy", "flowday-deploy", "links-deploy", "watch-deploy")
# The retired generators' required GitHub variables, still set in production: a revert of the committed-config
# layout needs them (README "Rolling back the committed-config layout"), and nothing may read them now.
LEGACY_VARIABLES = {
    "CLOUDFLARE_ACCOUNT_ID",
    "MAIL_HERO_PUBLIC_HOST",
    "MAIL_HERO_D1_DATABASE_ID",
    "MAIL_HERO_D1_DATABASE_NAME",
    "MAIL_HERO_R2_BUCKET_NAME",
    "MAIL_HERO_BACKUP_BUCKET_NAME",
    "MAIL_HERO_ACCESS_ISSUER",
    "MAIL_HERO_ACCESS_AUDIENCE",
    "MAIL_HERO_WEBHOOK_ALLOWED_HOSTS",
    "MAIL_HERO_INGEST_DAILY_MESSAGE_LIMIT",
    "MAIL_HERO_INGEST_DAILY_BYTE_LIMIT",
    "TODOFY_PUBLIC_HOST",
    "TODOFY_D1_DATABASE_ID",
    "TODOFY_HOOKS_HOSTS",
    "TODOFY_ACCESS_ISSUER",
    "TODOFY_ACCESS_AUDIENCE",
    "DASHBOARD_PUBLIC_HOST",
    "DASHBOARD_ACCESS_ISSUER",
    "DASHBOARD_ACCESS_AUDIENCE",
}


def load(path: str) -> dict:
    return tomllib.loads((REPO / path).read_text())


# Production Workers with a Custom Domain but no tile on 首页, and why.
NO_TILE = {"home": "the dashboard itself (dashboard/docs/design-v2.md Q11)"}


def registry_workers(registry: str) -> dict[str, str]:
    """The dashboard registry's WORKERS rows: script name -> entry id."""
    return dict(re.findall(r"\{ script: '([a-z0-9_-]+)', entry: '([a-z0-9_-]+)'", registry))


def registry_entries(registry: str) -> dict[str, dict]:
    """The dashboard registry's ENTRIES rows (id -> group and url), read from the object literals' own fields: one
    object per `  {` line, fields at four spaces, so comments and nested objects are never read as fields."""
    block = registry.split("const ENTRIES", 1)[1].split("\n];", 1)[0]
    entries = {}
    for row in re.split(r"^  \{$", block, flags=re.M)[1:]:
        fields = dict(re.findall(r"^    (id|group|url): (null|'[^']*')", row, re.M))
        entries[fields["id"].strip("'")] = {
            "group": fields["group"].strip("'"),
            "url": None if fields["url"] == "null" else fields["url"].strip("'"),
        }
    return entries


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


def wrapper_mode(call: str) -> str:
    """The `deploy-vars-inputs` mode of a wrapper call: "exec" / "secrets" (Mail Hero, dashboard, Lab); "core" /
    "gateway" for Todofy's `exec core` / `exec gateway`, and "secrets_core" / "secrets_gateway" for its `secrets`."""
    words = call.split()
    return words[-1] if words[0] == "exec" else "_".join(words)


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


def needs(job: str) -> list[str]:
    """The jobs a job block needs (`needs: x` or `needs: [x, y]`)."""
    match = re.search(r"^    needs: (?:\[(.*)\]|(\S+))$", job, re.M)
    if not match:
        return []
    return [name.strip() for name in (match.group(1) or match.group(2)).split(",")]


# The wrangler commands a check job may run: each works without a Cloudflare account (`deploy` only with --dry-run,
# which bundles without a request; `dev` and `types` stay local). Anything else (a real deploy, `versions upload`,
# `secret`, `d1`, `r2` or `kv` against the account) belongs in a deploy job.
CHECK_JOB_WRANGLER = {"deploy", "dev", "types"}


def production_reach(block: str) -> list[str]:
    """How a job block (or the workflow's top level) could reach production; empty when it cannot. A `${{ }}`
    expression that names the secrets context, `secrets:` passed to a called workflow, a deployment environment
    (whose secrets the job would get), a wrangler command outside CHECK_JOB_WRANGLER, a `wrangler deploy` without
    --dry-run, or a wrangler call with --remote."""
    found = []
    if any(re.search(r"\bsecrets\b", expression) for expression in re.findall(r"\$\{\{(.*?)\}\}", block)):
        found.append("reads a secret")
    if re.search(r"^ +secrets:", block, re.M):
        found.append("passes secrets to a called workflow")
    if re.search(r"^ +environment:", block, re.M):
        found.append("runs in a deployment environment")
    for step in steps(block):
        for line in step["run"].replace("\\\n", " ").splitlines():
            commands = wrangler_commands(line)
            for command in commands:
                if command not in CHECK_JOB_WRANGLER:
                    found.append(f"runs `wrangler {command}`")
                elif command == "deploy" and not re.search(r"(?<!\S)--dry-run(?:=true)?(?!\S)", line):
                    found.append("runs `wrangler deploy` without --dry-run")
            if commands and re.search(r"(?<!\S)--remote(?:=|(?!\S))", line):
                found.append("runs wrangler with --remote")
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
        self.assertEqual(configs, set(PRODUCTION.values()) | set(UNDEPLOYED.values()) | TEST_CONFIGS)
        for path in PRODUCTION.values():
            self.assertEqual(path.rsplit("/", 1)[-1], "wrangler.toml", path)

    def test_every_config_is_top_level_only(self):
        for path in [*PRODUCTION.values(), *UNDEPLOYED.values(), *sorted(TEST_CONFIGS)]:
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

    def test_dev_only_settings_never_reach_a_deploy(self):
        """DEV_* settings are local development and test switches (the loopback login bypass DEV_AUTH_BYPASS, the
        dashboard's pinned request clock DEV_NOW): no production config commits one, no deploy job sets or passes one,
        and no deploy-vars wrapper injects or uploads one, so no deploy can switch one on."""
        dev = re.compile(r"\bDEV_[A-Z0-9_]+")
        for path in PRODUCTION.values():
            with self.subTest(path=path):
                self.assertEqual(dev.findall(uncommented(path)), [])
        jobs = workflow_jobs()
        for job in DEPLOY_JOBS:
            with self.subTest(job=job):
                self.assertEqual(dev.findall(jobs[job]), [])
        for wrapper, _, _ in WRAPPERS.values():
            with self.subTest(wrapper=wrapper):
                self.assertEqual(dev.findall((REPO / wrapper).read_text()), [])

    def test_cross_worker_bindings_name_existing_workers(self):
        gateway = load(PRODUCTION["todofy"])
        [binding] = gateway["durable_objects"]["bindings"]
        self.assertIn(binding["script_name"], PRODUCTION)
        self.assertEqual(binding["script_name"], "todofy-core")
        for worker in ("home", "lab"):
            for service in load(PRODUCTION[worker])["services"]:
                with self.subTest(worker=worker, service=service["binding"]):
                    self.assertIn(service["service"], PRODUCTION)
                    self.assertEqual(service["entrypoint"], "Ops")
        # Lab reaches Todofy only through the gateway's Ops entrypoint (contracts/task-intent-v1).
        self.assertEqual(
            [(s["binding"], s["service"]) for s in load(PRODUCTION["lab"])["services"]], [("TODOFY", "todofy")]
        )


class Undeployed(unittest.TestCase):
    """A config CI only checks: on the shared account, closed to the internet (no workers.dev, no preview URL, no
    route), nothing personal committed, no deploy job, and its wrapper's inputs only ever placeholders in ci.yml.
    A new app starts here, as FlowDay did until F2, the links app until L2 and the watch app until W2."""

    # Worker name -> its deploy wrapper, for every UNDEPLOYED config (none since W2).
    WRAPPER: dict[str, str] = {}

    def test_every_undeployed_config_names_its_wrapper(self):
        self.assertEqual(set(self.WRAPPER), set(UNDEPLOYED))
        self.assertFalse(set(UNDEPLOYED) & set(PRODUCTION))

    def test_closed_and_on_the_shared_account(self):
        accounts = {load(path)["account_id"] for path in PRODUCTION.values()}
        for name, path in UNDEPLOYED.items():
            with self.subTest(path=path):
                config = load(path)
                self.assertEqual(config["name"], name)
                self.assertNotIn(name, PRODUCTION)
                self.assertEqual({config["account_id"]}, accounts)
                self.assertIs(config.get("workers_dev"), False)
                self.assertIs(config.get("preview_urls"), False)
                self.assertNotIn("routes", config)
                self.assertNotIn("route", config)
                self.assertFalse([var for var in config.get("vars", {}) if var.startswith("DEV_") or var in PERSONAL_VARS])
                self.assertNotIn("@", uncommented(path))

    def test_no_deploy_job_and_only_placeholder_inputs(self):
        jobs = workflow_jobs()
        for name, wrapper in self.WRAPPER.items():
            app_jobs = {job: block for job, block in jobs.items() if job.startswith(f"{name}-")}
            self.assertEqual(set(app_jobs), {f"{name}-checks"})
            inputs = {input_name for names in markers(wrapper).values() for input_name in names if not input_name.startswith("GITHUB_")}
            self.assertTrue(inputs)
            seen = set()
            for job_name, job in app_jobs.items():
                self.assertNotRegex(job, r"\$\{\{\s*secrets\.")
                for step in steps(job):
                    for input_name in inputs & set(step["env"]):
                        seen.add(input_name)
                        with self.subTest(job=job_name, step=step["name"], input=input_name):
                            self.assertRegex(step["env"][input_name], r"^(''|[a-z.-]*@([a-z-]+\.)*example\.com|'0{64}')$")
                    for line in step["run"].replace("\\\n", " ").splitlines():
                        if "deploy" in wrangler_commands(line):
                            self.assertIn("--dry-run", line)
            self.assertEqual(seen, inputs)


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
        for worker in ("mail-hero", "todofy", "home", "lab", "flowday", "links", "watch"):
            with self.subTest(worker=worker):
                self.assertTrue(load(PRODUCTION[worker]).get("routes"))

    def test_every_dev_command_of_a_production_config_pins_its_origin(self):
        commands = self.commands()
        paths = {path for path, _ in commands}
        # The scripted and documented entry points of each app are all found (the scan still sees them).
        self.assertLessEqual(
            {
                "mail-hero/cloudflare/package.json",
                "dashboard/worker/package.json",
                "lab/worker/package.json",
                "flowday/worker/package.json",
                "links/worker/package.json",
                "watch/worker/package.json",
                "todofy/docs/dev-notes.md",
            },
            paths,
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

    def test_the_website_is_exactly_www_and_the_apex(self):
        """The site Worker's Custom Domains are its complete set (every release's `wrangler triggers deploy` replaces
        them), so the list must equal the live state: www (canonical) and the apex, nothing else. No production
        config uses a zone route since the apex redirect Worker and its `ziyixi.science/*` route were retired
        (2026-10-01): every hostname of every Worker is a Custom Domain."""
        self.assertEqual(
            load(PRODUCTION["ziyixi-website"])["routes"],
            [
                {"pattern": "www.ziyixi.science", "custom_domain": True},
                {"pattern": "ziyixi.science", "custom_domain": True},
            ],
        )
        for name, path in PRODUCTION.items():
            for route in load(path).get("routes", []):
                with self.subTest(worker=name, route=route["pattern"]):
                    self.assertEqual(set(route), {"pattern", "custom_domain"})
                    self.assertIs(route["custom_domain"], True)
                    self.assertRegex(route["pattern"], r"^[a-z0-9-]+(\.[a-z0-9-]+)+$")
        self.assertNotIn("ziyixi-apex-redirect", PRODUCTION)

    def test_the_dashboard_host_is_its_own(self):
        host = self.home["vars"]["PUBLIC_HOST"]
        self.assertEqual(self.home["routes"], [{"pattern": host, "custom_domain": True}])
        self.assertNotIn(host, {self.mail_hero, self.todofy, *self.hooks})

    def test_flowday_is_on_its_production_host_only(self):
        """F4: FlowDay's one Custom Domain is its PUBLIC_HOST (the CSRF origin), the production host it took over
        from the old container. The F3 staging host flowday-next.ziyixi.science is in no config any more."""
        flowday = load(PRODUCTION["flowday"])
        host = flowday["vars"]["PUBLIC_HOST"]
        self.assertEqual(host, "flowday.ziyixi.science")
        self.assertEqual(flowday["routes"], [{"pattern": host, "custom_domain": True}])
        hosts = [route["pattern"] for path in PRODUCTION.values() for route in load(path).get("routes", [])]
        self.assertEqual(hosts.count(host), 1)
        self.assertNotIn("flowday-next.ziyixi.science", hosts)

    def test_links_is_on_its_one_host(self):
        """L2: the links app's one Custom Domain is its PUBLIC_HOST (the CSRF origin), s.ziyixi.science."""
        links = load(PRODUCTION["links"])
        host = links["vars"]["PUBLIC_HOST"]
        self.assertEqual(host, "s.ziyixi.science")
        self.assertEqual(links["routes"], [{"pattern": host, "custom_domain": True}])

    def test_watch_is_on_its_one_host(self):
        """W2: the watch app's one Custom Domain is its PUBLIC_HOST (the CSRF origin), watch.ziyixi.science."""
        watch = load(PRODUCTION["watch"])
        host = watch["vars"]["PUBLIC_HOST"]
        self.assertEqual(host, "watch.ziyixi.science")
        self.assertEqual(watch["routes"], [{"pattern": host, "custom_domain": True}])

    def test_the_core_links_to_the_gateway_host(self):
        self.assertEqual(load(PRODUCTION["todofy-core"])["vars"]["TODOFY_PUBLIC_HOST"], self.todofy)

    def test_the_dashboard_links_to_the_app_hosts(self):
        """Each app tile opens its Worker's PUBLIC_HOST; the links tile opens the launcher /_/ (links/docs/design.md)."""
        registry = (REPO / "dashboard" / "worker" / "src" / "registry.ts").read_text()
        urls = dict(re.findall(r"id: '(mail-hero|todofy|lab|flowday|links)',[^}]*?url: '([^']+)'", registry, re.S))
        host = {app: load(PRODUCTION[app])["vars"]["PUBLIC_HOST"] for app in ("lab", "flowday", "links")}
        self.assertEqual(
            urls,
            {
                "mail-hero": f"https://{self.mail_hero}/",
                "todofy": f"https://{self.todofy}/",
                "lab": f"https://{host['lab']}/",
                "flowday": f"https://{host['flowday']}/",
                "links": f"https://{host['links']}/_/",
            },
        )

    def test_the_dashboard_registers_every_production_worker_and_d1_database(self):
        """Every deployed Worker has a WORKERS row in dashboard/worker/src/registry.ts and every D1 database a resource
        whose match is its database_id, so a new app (FlowDay at F4, links at L2, watch at W2) cannot show up on the
        dashboard as 未登记. An app moves into PRODUCTION when it deploys, and this then fails until the registry names
        it. That it also has a tile is the next test."""
        registry = (REPO / "dashboard" / "worker" / "src" / "registry.ts").read_text()
        scripts = registry_workers(registry)
        d1 = set(re.findall(r"kind: 'd1',[^}]*?match: '([0-9a-f-]{36})'", registry))
        for worker, path in PRODUCTION.items():
            with self.subTest(worker=worker):
                self.assertIn(worker, scripts)
                for database in load(path).get("d1_databases", []):
                    self.assertIn(database["database_id"], d1, f"D1 {database['database_name']} is not a registry resource")

    def test_every_production_worker_with_a_host_has_a_visible_tile(self):
        """A registered Worker can still be off 首页: the links app was, from L2 until 2026-10-02, under a hidden entry
        with no URL. So every production Worker with a Custom Domain must map, through its WORKERS row, to an ENTRIES
        row in a visible group (apps or sites) whose url is on one of that Worker's Custom Domains. A Worker without a
        route (todofy-core, ziyixi-notion-publish) is reached through another and needs no tile of its own."""
        registry = (REPO / "dashboard" / "worker" / "src" / "registry.ts").read_text()
        entries = registry_entries(registry)
        workers = registry_workers(registry)
        for worker, path in PRODUCTION.items():
            hosts = {route["pattern"] for route in load(path).get("routes", [])}
            with self.subTest(worker=worker):
                self.assertIn(worker, workers, f"{worker} has no WORKERS row")
                if worker in NO_TILE:
                    self.assertTrue(hosts, f"{worker} has no Custom Domain, drop its NO_TILE exemption")
                    self.assertEqual(entries[workers[worker]]["group"], "hidden")
                    continue
                if not hosts:
                    continue
                entry = entries[workers[worker]]
                self.assertIn(entry["group"], {"apps", "sites"}, f"{worker} is registered under a hidden entry")
                self.assertIsNotNone(entry["url"], f"{worker}'s entry has no link")
                self.assertIn(re.match(r"https://([^/]+)/", entry["url"]).group(1), hosts)

    def test_the_registry_parser_sees_a_hidden_entry(self):
        """The two tests above read registry.ts with regular expressions; a hidden, link-less entry must parse as such,
        or the tile rule would pass on the very state it exists to catch."""
        sample = """const ENTRIES: readonly EntryDef[] = [
  {
    // A comment with id: 'not-this' and url: 'https://x.ziyixi.science/' inside.
    id: 'links',
    group: 'hidden',
    url: null,
    status: { type: 'none' },
  },
  {
    id: 'lab',
    group: 'apps',
    url: 'https://lab.ziyixi.science/',
  },
];

const WORKERS: readonly WorkerDef[] = [
  { script: 'links', entry: 'links', role: 'x' },
];
"""
        self.assertEqual(
            registry_entries(sample),
            {"links": {"group": "hidden", "url": None}, "lab": {"group": "apps", "url": "https://lab.ziyixi.science/"}},
        )
        self.assertEqual(registry_workers(sample), {"links": "links"})


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
                        mode = wrapper_mode(call)
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

    def test_no_job_before_the_deploys_can_reach_production(self):
        """Every branch push runs "Changes", the check jobs and "CI gate" with no environment, and a push to main
        takes their verdict from a green branch run of the same commit (ci_changes.find_reusable: "no check job
        uses a secret"). So none of them, nor the workflow's top level, may read a secret, run in an environment,
        deploy for real or touch the account with wrangler."""
        self.assertEqual(production_reach(WORKFLOW.read_text().split("\njobs:\n", 1)[0]), [])
        before = {name: block for name, block in self.jobs.items() if name == "gate" or "gate" not in needs(block)}
        # They include every job whose result a reused run vouches for (ci.yml names; a matrix is "<name> (*)").
        names = {
            re.sub(r" \(\$\{\{ matrix\.shard \}\}/\d+\)$", " (*)", re.search(r"^    name: (.+)$", block, re.M).group(1))
            for block in before.values()
        }
        reused = {name for jobs in ci_changes.CHECK_JOBS.values() for name in jobs}
        self.assertLessEqual({*ci_changes.ALWAYS_JOBS, *reused}, names)
        for name, block in before.items():
            with self.subTest(job=name):
                self.assertEqual(production_reach(block), [])

    def test_the_production_reach_detector(self):
        """production_reach sees each way into production, and not the checks' dry-run with a secrets *file*."""
        dry_run = (
            "        run: |\n"
            "          node ../deploy/deploy-vars.mjs exec -- npx --no-install wrangler deploy --dry-run \\\n"
            '            --config ../wrangler.toml --secrets-file "$RUNNER_TEMP/app-secrets.json"\n'
        )
        job = (
            "    name: App checks\n    needs: changes\n    runs-on: ubuntu-24.04\n    steps:\n"
            "      - name: Dry-run the committed config\n        working-directory: app/worker\n"
            "        env:\n          APP_ACCESS_OWNER: owner@example.com\n" + dry_run
        )
        self.assertEqual(production_reach(job), [])
        self.assertEqual(needs(job), ["changes"])

        def step(command: str) -> str:
            return f"      - name: Step\n        run: |\n          npx --no-install wrangler {command} -c ../wrangler.toml\n"

        token = "owner@example.com\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}"
        environment = "    environment:\n      name: production\n    steps:\n"
        for mutated, expected in (
            (job.replace("owner@example.com", token), "reads a secret"),
            (job.replace("owner@example.com", "${{secrets['APP_ACCESS_OWNER']}}"), "reads a secret"),
            (job.replace("owner@example.com", "${{ toJSON(secrets) }}"), "reads a secret"),
            (job.replace("    steps:\n", environment), "runs in a deployment environment"),
            (job.replace("    steps:\n", "    secrets: inherit\n    steps:\n"), "passes secrets to a called workflow"),
            (job.replace(" --dry-run", ""), "runs `wrangler deploy` without --dry-run"),
            (job.replace(" --dry-run", " --dry-run=false"), "runs `wrangler deploy` without --dry-run"),
            (job + step("versions upload"), "runs `wrangler versions upload`"),
            (job + step("secret put KEY"), "runs `wrangler secret`"),
            (job + step("d1 migrations apply DB --remote"), "runs wrangler with --remote"),
            (job + step("dev --remote"), "runs wrangler with --remote"),
        ):
            with self.subTest(expected=expected, mutated=mutated[-120:]):
                self.assertIn(expected, production_reach(mutated))
        self.assertEqual(needs("    needs: [changes, gate]\n"), ["changes", "gate"])

    def test_personal_values_are_worker_secrets(self):
        """Every personal value (the receive address, the owners' Access identities, Todofy's Todoist projects) reaches
        its Worker as a Worker secret (a wrapper's `secrets` mode, deployed with --secrets-file), never as a --var:
        Wrangler and the Cloudflare dashboard show a plain var's value. Every deploy (and dry-run) that runs `exec` of
        such a wrapper passes exactly the file that the same job's `secrets` call wrote for that Worker."""
        found = set()
        written_pattern = re.compile(r"deploy[-_]vars\.(?:mjs|py) secrets(?: (core|gateway))? (\S+)")
        exec_pattern = re.compile(r"deploy[-_]vars\.(?:mjs|py) exec(?: (core|gateway))? -- .*\b(?:py)?wrangler deploy\b")
        for app, (wrapper, _, _) in WRAPPERS.items():
            inputs = markers(wrapper)
            with self.subTest(app=app):
                secret_modes = {mode for mode in inputs if mode == "secrets" or mode.startswith("secrets_")}
                for mode, names in inputs.items():
                    if mode not in secret_modes:
                        self.assertFalse(PERSONAL_INPUTS & set(names), mode)
                personal = PERSONAL_INPUTS & {name for mode in secret_modes for name in inputs[mode]}
                found |= personal
                if not personal:
                    continue
                calls = 0
                for job_name, job in self.app_jobs(app).items():
                    written: dict[str, str] = {}
                    for step in steps(job):
                        for line in step["run"].replace("\\\n", " ").splitlines():
                            if match := written_pattern.search(line):
                                written[match.group(1) or ""] = match.group(2)
                            if match := exec_pattern.search(line):
                                calls += 1
                                with self.subTest(job=job_name, step=step["name"], worker=match.group(1)):
                                    files = re.findall(r"--secrets-file[ =](\S+)", line)
                                    self.assertEqual(files, [written.get(match.group(1) or "")])
                self.assertGreaterEqual(calls, 2)
        self.assertEqual(found, PERSONAL_INPUTS)

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

    def test_the_rollback_note_names_every_legacy_variable_and_ci_reads_none(self):
        readme = (REPO / "README.md").read_text()
        section = readme.split("#### Rolling back the committed-config layout", 1)[1].split("\n#", 1)[0]
        self.assertEqual(set(re.findall(r"`([A-Z][A-Z0-9_]+)`", section)) & LEGACY_VARIABLES, LEGACY_VARIABLES)
        self.assertFalse(LEGACY_VARIABLES & set(re.findall(r"\b(?:vars|env)\.([A-Z0-9_]+)", WORKFLOW.read_text())))
        self.assertFalse(LEGACY_VARIABLES & TOGGLES)

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
                            self.assertEqual(value, f"${{{{ secrets.{SHARED_SECRETS.get(name, name)} }}}}")
                        else:
                            self.assertRegex(value, r"^(''|placeholder|[a-z.-]*@([a-z-]+\.)*example\.com)$")

    def test_lab_deploy_reads_the_dashboard_owner_and_its_own_csrf_key(self):
        """Lab's owner addresses come from the dashboard's secrets (no LAB_ACCESS_OWNER* secret exists); its CSRF
        key stays its own. The secrets are read only where the secrets file is written."""
        self.assertLessEqual(set(SHARED_SECRETS), PERSONAL_INPUTS)
        self.assertLessEqual(set(SHARED_SECRETS.values()), PERSONAL_INPUTS)
        read = {}
        for step in steps(self.jobs["lab-deploy"]):
            for name, value in step["env"].items():
                if match := re.fullmatch(r"\$\{\{ secrets\.([A-Z0-9_]+) \}\}", value):
                    read.setdefault(name, set()).add(match.group(1))
        self.assertEqual(read["LAB_ACCESS_OWNER"], {"DASHBOARD_ACCESS_OWNER"})
        self.assertEqual(read["LAB_ACCESS_OWNER_ALIASES"], {"DASHBOARD_ACCESS_OWNER_ALIASES"})
        self.assertEqual(read["LAB_CSRF_SIGNING_KEY"], {"LAB_CSRF_SIGNING_KEY"})
        self.assertNotIn("DASHBOARD_CSRF_SIGNING_KEY", {secret for names in read.values() for secret in names})
        self.assertNotRegex(WORKFLOW.read_text(), r"secrets\.LAB_ACCESS_OWNER")

    def test_flowday_deploy_reads_the_dashboard_owner_and_its_own_keys(self):
        """FlowDay's owner addresses come from the dashboard's secrets (no FLOWDAY_ACCESS_OWNER* secret exists); its
        CSRF key and credential key are its own, never another app's."""
        read = {}
        for step in steps(self.jobs["flowday-deploy"]):
            for name, value in step["env"].items():
                if match := re.fullmatch(r"\$\{\{ secrets\.([A-Z0-9_]+) \}\}", value):
                    read.setdefault(name, set()).add(match.group(1))
        self.assertEqual(read["FLOWDAY_ACCESS_OWNER"], {"DASHBOARD_ACCESS_OWNER"})
        self.assertEqual(read["FLOWDAY_ACCESS_OWNER_ALIASES"], {"DASHBOARD_ACCESS_OWNER_ALIASES"})
        self.assertEqual(read["FLOWDAY_CSRF_SIGNING_KEY"], {"FLOWDAY_CSRF_SIGNING_KEY"})
        self.assertEqual(read["FLOWDAY_CREDENTIAL_KEY"], {"FLOWDAY_CREDENTIAL_KEY"})
        self.assertEqual(read["CLOUDFLARE_API_TOKEN"], {"CF_API_TOKEN"})
        self.assertEqual(set(read), {*markers(WRAPPERS["flowday"][0])["secrets"], "CLOUDFLARE_API_TOKEN"})
        self.assertNotRegex(WORKFLOW.read_text(), r"secrets\.FLOWDAY_ACCESS_OWNER")
        # The secrets are read only where the secrets file is written (and the token where Cloudflare is called).
        writers = [step["name"] for step in steps(self.jobs["flowday-deploy"]) if "FLOWDAY_CSRF_SIGNING_KEY" in step["env"]]
        self.assertEqual(writers, ["Write the Worker secrets file"])

    def test_flowday_deploy_applies_migrations_before_the_worker_and_then_checks_production(self):
        """F2: `wrangler d1 migrations apply DB --remote`, then the real deploy through the wrapper, in one step after
        the hostname guard; then a check of the live version and the migrations through the API (the host's /health
        needs an owner login), before the probes of its host (PUBLIC_HOST, since F3)."""
        flowday = steps(self.jobs["flowday-deploy"])
        names = [step["name"] for step in flowday]
        guard = names.index("Check the hostnames against production")
        [deploy] = [i for i, s in enumerate(flowday) if "deploy" in wrangler_commands(s["run"]) and "--dry-run" not in s["run"]]
        self.assertLess(guard, deploy)
        script = flowday[deploy]["run"]
        self.assertLess(script.index("wrangler d1 migrations apply DB --remote --config ../wrangler.toml"), script.index("deploy-vars.mjs exec"))
        check = flowday[deploy + 1]
        self.assertEqual(check["name"], "Check that production runs this commit")
        for command in ("deployments status", "versions view", "d1 migrations list DB --remote"):
            self.assertIn(f"wrangler {command}", check["run"])
        # Reads only: no deploy, upload, rollback, secret or SQL in the check.
        self.assertFalse({"deploy", "versions upload", "versions deploy", "rollback", "secret"} & set(wrangler_commands(check["run"])))
        self.assertNotIn("execute", check["run"])

    def test_lab_holds_the_bundle_it_dry_runs_to_its_budget(self):
        """Lab checks and Lab deploy measure the dry run's bundle (deploy/bundle-size.mjs: Lab's budget and the Workers
        Free limit) in the same step that writes it, so the bundle that ships is the one measured."""
        for job in ("lab-checks", "lab-deploy"):
            [dry] = [s for s in steps(self.jobs[job]) if "--dry-run" in s["run"] and "deploy-vars.mjs exec" in s["run"]]
            with self.subTest(job=job):
                self.assertIn('--outdir "$RUNNER_TEMP/lab-bundle"', dry["run"])
                self.assertIn('node ../deploy/bundle-size.mjs "$RUNNER_TEMP/lab-bundle"', dry["run"])
                self.assertLess(dry["run"].index("--outdir"), dry["run"].index("bundle-size.mjs"))

    def test_lab_deploy_checks_production_runs_this_commit_before_probing_access(self):
        """Access answers before the Worker runs, so Lab deploy reads the live version as FlowDay deploy does: right
        after the real deploy, the same step (reads only), then the Access probe."""
        lab = steps(self.jobs["lab-deploy"])
        flowday = steps(self.jobs["flowday-deploy"])
        [deploy] = [i for i, s in enumerate(lab) if "deploy" in wrangler_commands(s["run"]) and "--dry-run" not in s["run"]]
        check = lab[deploy + 1]
        self.assertEqual(check["name"], "Check that production runs this commit")
        self.assertEqual(lab[deploy + 2]["name"], "Check that Access answers unauthenticated requests")
        [same] = [s for s in flowday if s["name"] == check["name"]]
        self.assertEqual(check["run"].replace("Worker lab", "Worker flowday"), same["run"])
        self.assertFalse({"deploy", "versions upload", "versions deploy", "rollback", "secret"} & set(wrangler_commands(check["run"])))

    def test_links_deploy_reads_the_dashboard_owner_and_its_own_csrf_key(self):
        """The links app's owner addresses come from the dashboard's secrets (no LINKS_ACCESS_OWNER* secret exists); its
        CSRF key is its own, never another app's. The secrets are read only where the secrets file is written."""
        read = {}
        for step in steps(self.jobs["links-deploy"]):
            for name, value in step["env"].items():
                if match := re.fullmatch(r"\$\{\{ secrets\.([A-Z0-9_]+) \}\}", value):
                    read.setdefault(name, set()).add(match.group(1))
        self.assertEqual(read["LINKS_ACCESS_OWNER"], {"DASHBOARD_ACCESS_OWNER"})
        self.assertEqual(read["LINKS_ACCESS_OWNER_ALIASES"], {"DASHBOARD_ACCESS_OWNER_ALIASES"})
        self.assertEqual(read["LINKS_CSRF_SIGNING_KEY"], {"LINKS_CSRF_SIGNING_KEY"})
        self.assertEqual(read["CLOUDFLARE_API_TOKEN"], {"CF_API_TOKEN"})
        self.assertEqual(set(read), {*markers(WRAPPERS["links"][0])["secrets"], "CLOUDFLARE_API_TOKEN"})
        self.assertNotRegex(WORKFLOW.read_text(), r"secrets\.LINKS_ACCESS_OWNER")
        writers = [step["name"] for step in steps(self.jobs["links-deploy"]) if "LINKS_CSRF_SIGNING_KEY" in step["env"]]
        self.assertEqual(writers, ["Write the Worker secrets file"])

    def test_links_deploy_applies_migrations_before_the_worker_and_then_checks_production_and_the_host(self):
        """L2: after the hostname guard, `wrangler d1 migrations apply DB --remote` and then the real deploy through the
        wrapper in one step; then FlowDay's check of the live version and the migrations (reads only), the Access probe
        of the owner's half and the probe of the Worker's own anonymous answers."""
        links = steps(self.jobs["links-deploy"])
        names = [step["name"] for step in links]
        guard = names.index("Check the hostnames against production")
        [deploy] = [i for i, s in enumerate(links) if "deploy" in wrangler_commands(s["run"]) and "--dry-run" not in s["run"]]
        self.assertLess(guard, deploy)
        script = links[deploy]["run"]
        self.assertLess(script.index("wrangler d1 migrations apply DB --remote --config ../wrangler.toml"), script.index("deploy-vars.mjs exec"))
        check = links[deploy + 1]
        self.assertEqual(check["name"], "Check that production runs this commit")
        [same] = [s for s in steps(self.jobs["flowday-deploy"]) if s["name"] == check["name"]]
        self.assertEqual(check["run"].replace("Worker links", "Worker flowday"), same["run"])
        self.assertEqual(
            names[deploy + 2 :],
            [
                "Check that Access answers unauthenticated requests",
                "Check that the Worker answers short links without Access",
                "Remove the secrets file",
            ],
        )
        for step in links[deploy + 1 :]:
            with self.subTest(step=step["name"]):
                self.assertFalse({"deploy", "versions upload", "versions deploy", "rollback", "secret"} & set(wrangler_commands(step["run"])))

    def test_links_holds_the_bundle_it_dry_runs_to_its_budget(self):
        """Links checks and Links deploy measure the dry run's bundle (deploy/bundle-size.mjs) in the step that writes it."""
        for job in ("links-checks", "links-deploy"):
            [dry] = [s for s in steps(self.jobs[job]) if "--dry-run" in s["run"] and "deploy-vars.mjs exec" in s["run"]]
            with self.subTest(job=job):
                self.assertIn('--outdir "$RUNNER_TEMP/links-bundle"', dry["run"])
                self.assertIn('node ../deploy/bundle-size.mjs "$RUNNER_TEMP/links-bundle"', dry["run"])
                self.assertLess(dry["run"].index("--outdir"), dry["run"].index("bundle-size.mjs"))

    def test_watch_deploy_reads_the_dashboard_owner_and_its_own_csrf_key(self):
        """The watch app's owner addresses come from the dashboard's secrets (no WATCH_ACCESS_OWNER* secret exists); its
        CSRF key is its own (WATCH_CSRF_SIGNING_KEY), never another app's. The secrets are read only where the secrets
        file is written."""
        read = {}
        for step in steps(self.jobs["watch-deploy"]):
            for name, value in step["env"].items():
                if match := re.fullmatch(r"\$\{\{ secrets\.([A-Z0-9_]+) \}\}", value):
                    read.setdefault(name, set()).add(match.group(1))
        self.assertEqual(read["WATCH_ACCESS_OWNER"], {"DASHBOARD_ACCESS_OWNER"})
        self.assertEqual(read["WATCH_ACCESS_OWNER_ALIASES"], {"DASHBOARD_ACCESS_OWNER_ALIASES"})
        self.assertEqual(read["WATCH_CSRF_SIGNING_KEY"], {"WATCH_CSRF_SIGNING_KEY"})
        self.assertEqual(read["CLOUDFLARE_API_TOKEN"], {"CF_API_TOKEN"})
        self.assertEqual(set(read), {*markers(WRAPPERS["watch"][0])["secrets"], "CLOUDFLARE_API_TOKEN"})
        self.assertNotRegex(WORKFLOW.read_text(), r"secrets\.WATCH_ACCESS_OWNER")
        writers = [step["name"] for step in steps(self.jobs["watch-deploy"]) if "WATCH_CSRF_SIGNING_KEY" in step["env"]]
        self.assertEqual(writers, ["Write the Worker secrets file"])

    def test_watch_deploy_guards_the_host_then_deploys_and_checks_production_and_access(self):
        """W2: after the dry run and the hostname guard, the real deploy through the wrapper (no D1); then the links
        app's check of the live version without its D1 part (reads only) and the Access probe of the whole host."""
        watch = steps(self.jobs["watch-deploy"])
        names = [step["name"] for step in watch]
        guard = names.index("Check the hostnames against production")
        [dry] = [i for i, s in enumerate(watch) if "--dry-run" in s["run"] and "deploy-vars.mjs exec" in s["run"]]
        [deploy] = [i for i, s in enumerate(watch) if "deploy" in wrangler_commands(s["run"]) and "--dry-run" not in s["run"]]
        self.assertLess(dry, guard)
        self.assertLess(guard, deploy)
        self.assertNotIn("d1", watch[deploy]["run"])
        check = watch[deploy + 1]
        self.assertEqual(check["name"], "Check that production runs this commit")
        self.assertEqual(names[deploy + 2 :], ["Check that Access answers unauthenticated requests", "Remove the secrets file"])
        for step in watch[deploy + 1 :]:
            with self.subTest(step=step["name"]):
                self.assertFalse({"deploy", "versions upload", "versions deploy", "rollback", "secret"} & set(wrangler_commands(step["run"])))

    def test_watch_holds_the_bundle_it_dry_runs_to_its_budget(self):
        """Watch checks and Watch deploy measure the dry run's bundle (deploy/bundle-size.mjs) in the step that writes it."""
        for job in ("watch-checks", "watch-deploy"):
            [dry] = [s for s in steps(self.jobs[job]) if "--dry-run" in s["run"] and "deploy-vars.mjs exec" in s["run"]]
            with self.subTest(job=job):
                self.assertIn('--outdir "$RUNNER_TEMP/watch-bundle"', dry["run"])
                self.assertIn('node ../deploy/bundle-size.mjs "$RUNNER_TEMP/watch-bundle"', dry["run"])
                self.assertLess(dry["run"].index("--outdir"), dry["run"].index("bundle-size.mjs"))

    def test_lab_flowday_links_and_watch_accept_exactly_the_owner_values_the_dashboard_accepts(self):
        """The same secrets feed these wrappers: their owner and alias rules must be the same lines, or a valid
        dashboard value could stop Lab deploy, FlowDay deploy or Links deploy (or the watch app's, from W2), or the
        reverse. Here, in Changes, a change to any one wrapper runs this comparison, whichever app's checks it runs."""
        rules = r"^(?:const ACCESS_EMAIL|const MAX_ALIASES|const MAX_LIST_CHARS) = .+$"
        lab, dashboard, flowday, links, watch = (
            re.findall(rules, (REPO / app / "deploy" / "deploy-vars.mjs").read_text(), re.M)
            for app in ("lab", "dashboard", "flowday", "links", "watch")
        )
        self.assertEqual(len(dashboard), 3)
        self.assertEqual(lab, dashboard)
        self.assertEqual(flowday, dashboard)
        self.assertEqual(links, dashboard)
        self.assertEqual(watch, dashboard)

    def test_the_lab_rollback_note_covers_what_its_first_release_leaves_live(self):
        """Lab's first release has no earlier version: its README must name what `Lab deploy` makes live (Worker,
        Custom Domain, Durable Object, D1), the steps after which that is so, the stop switch, what the dashboard
        must drop first, Lab's own secrets and Todofy's intake switch."""
        section = (REPO / "lab/README.md").read_text().split("### Rollback and removal", 1)[1].split("\n#", 1)[0]
        lab = load(PRODUCTION["lab"])
        names = {lab["name"], *(route["pattern"] for route in lab["routes"])}
        names |= {binding["class_name"] for binding in lab["durable_objects"]["bindings"]}
        names |= {database["database_name"] for database in lab["d1_databases"]}
        names |= {s["binding"] for s in load(PRODUCTION["home"])["services"] if s["service"] == lab["name"]}
        read = {job: set(re.findall(r"secrets\.([A-Z0-9_]+)", self.jobs[job])) for job in DEPLOY_JOBS}
        own = read["lab-deploy"] - set().union(*(read[job] for job in DEPLOY_JOBS if job != "lab-deploy"))
        self.assertEqual(own - {"CLOUDFLARE_API_TOKEN"}, {"LAB_CSRF_SIGNING_KEY"})
        names |= own - {"CLOUDFLARE_API_TOKEN"}
        names |= {"TASK_INTENT_SOURCES", "LAB_DAILY_NEURONS", "ingest_paused"}
        for name in sorted(names):
            with self.subTest(name=name):
                self.assertRegex(section, rf"`{re.escape(name)}(`| = )")
        lab_steps = steps(self.jobs["lab-deploy"])
        # The live deploy step and the two checks right after it (the live version, the Access probe), quoted by
        # name (line breaks aside).
        [index] = [
            i for i, s in enumerate(lab_steps) if "deploy" in wrangler_commands(s["run"]) and "--dry-run" not in s["run"]
        ]
        flat = " ".join(section.split())
        for step in lab_steps[index : index + 3]:
            with self.subTest(step=step["name"]):
                self.assertIn(f'"{step["name"]}"', flat)
        self.assertIn("wrangler versions view", lab_steps[index + 1]["run"])
        self.assertIn("curl", lab_steps[index + 2]["run"])
        # The stop switch as the settings page labels it.
        label = "暂停抓取新论文"
        self.assertIn(label, (REPO / "lab/web/src/views/Settings.tsx").read_text())
        self.assertIn(label, section)

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
