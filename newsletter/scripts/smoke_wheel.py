"""Install the built wheel with locked dependencies outside the source checkout.

Only package downloads may use the network. The demo uses fixtures and fake
providers; no .env, login state, provider credentials, or real mail are used.
The exported requirements file is disposable, never a second maintained lock.
"""

import argparse
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile


def main() -> None:
    """Install locked artifacts outside the repo and run an offline demo."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--uv", default="uv", help="uv executable (default: PATH)"
    )
    parser.add_argument(
        "--dist", type=pathlib.Path, default=pathlib.Path(".artifacts/dist")
    )
    args = parser.parse_args()
    uv = shutil.which(args.uv)
    if not uv:
        parser.error("uv is required")
    root = pathlib.Path(__file__).resolve().parents[1]
    dist = args.dist.resolve()
    wheels = sorted(dist.glob("personal_newsletter-*.whl"))
    if len(wheels) != 1:
        parser.error(
            "Build exactly one current wheel in --dist before this check"
        )
    # Fail on stale artifacts as well as missing package data. Nothing is
    # extracted.
    with zipfile.ZipFile(wheels[0]) as wheel:
        if any(
            name.startswith(("newsletter/generated/", "ziyixi_protos/"))
            for name in wheel.namelist()
        ):
            parser.error(
                "Newsletter wheel must depend on, not vendor, the public "
                "proto package"
            )
        for source in (root / "src" / "newsletter").rglob("*"):
            if source.is_file() and source.suffix in {
                ".py",
                ".pyi",
                ".json",
                ".j2",
                ".md",
                ".yaml",
            }:
                member = source.relative_to(root / "src").as_posix()
                if wheel.read(member) != source.read_bytes():
                    parser.error(f"Wheel is stale: {member}; rebuild first")
    sdists = sorted(dist.glob("personal_newsletter-*.tar.gz"))
    if len(sdists) != 1:
        parser.error("Build exactly one current source distribution in --dist")
    with tarfile.open(sdists[0]) as sdist:
        names = sdist.getnames()
        prefix = names[0].split("/")[0]
        for name in ("uv.lock", ".python-version", "MANIFEST.in"):
            member_file = sdist.extractfile(prefix + "/" + name)
            if (
                member_file is None
                or member_file.read() != (root / name).read_bytes()
            ):
                parser.error(
                    f"Source distribution is stale: {name}; rebuild first"
                )
        if any(
            "/tests/" in name or "/.env" in name or name.endswith("/auth.json")
            for name in names
        ):
            parser.error(
                "Source distribution contains unexpected local/test files"
            )
    env = {
        key: os.environ[key]
        for key in (
            "PATH",
            "HOME",
            "TMPDIR",
            "LANG",
            "UV_CACHE_DIR",
            "UV_OFFLINE",
        )
        if key in os.environ
    }
    env["UV_PYTHON_DOWNLOADS"] = "never"

    def run(*command: str, cwd: pathlib.Path) -> None:
        subprocess.run(command, cwd=cwd, env=env, check=True, timeout=180)

    with tempfile.TemporaryDirectory(
        prefix="newsletter-wheel-smoke-"
    ) as directory:
        temporary = pathlib.Path(directory).resolve()
        requirements = temporary / "requirements.txt"
        run(
            uv,
            "export",
            "--locked",
            "--no-dev",
            "--extra",
            "codex",
            "--no-emit-project",
            "--output-file",
            str(requirements),
            "--quiet",
            cwd=root,
        )
        environment = temporary / "venv"
        run(
            uv,
            "venv",
            "--python",
            sys.executable,
            str(environment),
            cwd=temporary,
        )
        python = str(environment / "bin" / "python")
        run(
            uv,
            "pip",
            "sync",
            "--python",
            python,
            "--require-hashes",
            str(requirements),
            cwd=temporary,
        )
        run(
            uv,
            "pip",
            "install",
            "--python",
            python,
            "--no-deps",
            "--no-index",
            str(wheels[0]),
            cwd=temporary,
        )
        run(uv, "pip", "check", "--python", python, cwd=temporary)
        run(
            python,
            "-c",
            "from importlib.resources import files; import newsletter; "
            "from pathlib import Path; import sys; "
            "assert Path(newsletter.__file__).resolve().is_relative_to(Path"
            "(sys.prefix)); "
            "assert all(files('newsletter').joinpath(p).is_file() for p in "
            "('templates/edition.html.j2', 'policy/editorial.md', "
            "'fixtures/packets.json', "
            "'instructions/01-ai-ml.md', 'workflows/daily.yaml', "
            "'instructions/discovery/_sources/ai-ml.md', "
            "'instructions/discovery/07-search-ads-recs.md', "
            "'instructions/discovery/08-llm-architectures.md', "
            "'workflows/legacy-daily.yaml', 'policy/story-editorial.md')); "
            "from newsletter.workflow.definition import load_definition; "
            "from newsletter.workflow.nodes import validate_recipe; "
            "validate_recipe(load_definition(Path(str(files('newsletter').j"
            "oinpath('workflows/daily.yaml'))))); "
            "from newsletter.collection.source_guides import "
            "load_discovery_instructions; "
            "directions = load_discovery_instructions(Path(str(files('newsl"
            "etter').joinpath('instructions/discovery')))); "
            "assert len(directions) == 8 and "
            "'https://proceedings.mlr.press/' in directions[0].text; "
            "from ziyixi_protos.newsletter import editorial_pb2 as pb; "
            "assert Path(pb.__file__).resolve().is_relative_to(Path(sys.pre"
            "fix)); "
            "assert all(files('ziyixi_protos.newsletter').joinpath(p).is_fi"
            "le() for p in "
            "('editorial_pb2.py', 'editorial_pb2.pyi', 'provenance.json')); "
            "from newsletter.preflight import check_proto_dependency; "
            "check_proto_dependency(); "
            "from codex_cli_bin import bundled_codex_path; "
            "assert Path(bundled_codex_path()).is_file()",
            cwd=temporary,
        )
        run(
            python,
            "-m",
            "newsletter.cli",
            "demo",
            "--output",
            str(temporary / "preview"),
            cwd=temporary,
        )
        assert (temporary / "preview" / "preview.html").is_file()
        assert len(list((temporary / "preview" / "outbox").glob("*.eml"))) == 1
        print(
            "Wheel smoke passed: locked dependencies, packaged "
            "resources/runtime, fake-only demo."
        )


if __name__ == "__main__":
    main()
