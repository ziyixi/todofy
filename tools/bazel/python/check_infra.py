"""Run the existing structural guard on exactly the declared Infra files."""

import argparse
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import infra_guard

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--tofu", type=Path)
parser.add_argument("--provider-files", nargs="+")
parser.add_argument("--platform", choices=("darwin_arm64", "linux_amd64"))
parser.add_argument("inputs", nargs="+")
args = parser.parse_args()

with tempfile.TemporaryDirectory(prefix="infra-static-") as temporary:
    root = Path(temporary)
    for name in args.inputs:
        source = Path(name)
        destination = root / source.relative_to("infra")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    problems = infra_guard.check(root)
    for problem in problems:
        print("infra_guard: " + problem, file=sys.stderr)
    if problems:
        raise SystemExit(1)
    if args.tofu:
        lock = (root / ".terraform.lock.hcl").read_text()
        version = re.search(r'\bversion\s*=\s*"([^"]+)"', lock)[1]
        provider_files = [
            Path(name).absolute()
            for group in args.provider_files
            for name in shlex.split(group)
        ]
        binary = next(
            path
            for path in provider_files
            if path.name.startswith("terraform-provider-cloudflare_v")
        )
        if not binary.name.startswith("terraform-provider-cloudflare_v" + version):
            raise ValueError("The fixed provider must match the existing Infra lock")
        mirror = root / "provider-mirror"
        installation = (
            mirror
            / "registry.opentofu.org/cloudflare/cloudflare"
            / version
            / args.platform
        )
        installation.mkdir(parents=True)
        for source in provider_files:
            if source.name not in {
                "BUILD.bazel",
                "WORKSPACE",
                "WORKSPACE.bazel",
                "REPO.bazel",
            }:
                shutil.copy2(source, installation / source.name)
        cli_config = root / "static-tofu.rc"
        cli_config.write_text(
            'provider_installation { filesystem_mirror { path = "'
            + str(mirror)
            + '" } }\n'
        )
        env = {
            "PATH": os.defpath,
            "TF_CLI_CONFIG_FILE": str(cli_config),
            "TF_INPUT": "0",
            "TF_IN_AUTOMATION": "1",
            "CHECKPOINT_DISABLE": "1",
        }
        tofu = str(args.tofu.absolute())
        subprocess.run(
            [tofu, "fmt", "-check", "-recursive", "-diff"],
            cwd=root,
            env=env,
            check=True,
        )
        subprocess.run(
            [
                tofu,
                "init",
                "-backend=false",
                "-input=false",
                "-lockfile=readonly",
                "-no-color",
            ],
            cwd=root,
            env=env,
            check=True,
        )
        subprocess.run([tofu, "validate", "-no-color"], cwd=root, env=env, check=True)
