"""Exercise the original wheel smoke against declared Bazel archives only."""

import os
import pathlib
import shutil
import sys
import tarfile
import tomllib
import venv
import zipfile
from importlib import metadata

import packaging.utils as package_utils
import smoke_wheel
from packaging import requirements


def install_bazel_runtime(
    archive: pathlib.Path, wheels: list[pathlib.Path], environment: pathlib.Path
) -> None:
    """Install declared artifacts into a clean venv without network access."""
    builder = venv.EnvBuilder(with_pip=False)
    builder.create(environment)
    context = builder.ensure_directories(environment)
    site = pathlib.Path(context.lib_path)
    extracted = environment.parent / "locked-runtime"
    with tarfile.open(archive) as dependencies:
        dependencies.extractall(extracted, filter="data")
    source = extracted / "opt/newsletter/.venv/lib/python3.14/site-packages"
    shutil.copytree(source, site, dirs_exist_ok=True)
    for wheel in wheels:
        with zipfile.ZipFile(wheel) as artifact:
            artifact.extractall(site)
    installed = {
        package_utils.canonicalize_name(distribution.metadata["Name"]): distribution
        for distribution in metadata.distributions(path=[str(site)])
    }
    for distribution in installed.values():
        for declaration in distribution.requires or []:
            required = requirements.Requirement(declaration)
            if required.marker is not None and not required.marker.evaluate():
                continue
            name = package_utils.canonicalize_name(required.name)
            if name not in installed or not required.specifier.contains(
                installed[name].version
            ):
                raise ValueError(f"Unsatisfied packaged dependency: {required.name}")


def test_packaged_wheel_smoke():
    project = pathlib.Path(os.environ["NEWSLETTER_PROJECT"])
    version = tomllib.loads(project.read_text())["project"]["version"]
    dist = pathlib.Path(os.environ["TEST_TMPDIR"]) / "dist"
    dist.mkdir()
    shutil.copyfile(
        os.environ["NEWSLETTER_WHEEL"],
        dist / f"personal_newsletter-{version}-py3-none-any.whl",
    )
    shutil.copyfile(
        os.environ["NEWSLETTER_SDIST"], dist / f"personal_newsletter-{version}.tar.gz"
    )
    sys.argv[:] = [
        "smoke_wheel.py",
        "--dist",
        str(dist),
        "--bazel-dependencies",
        os.environ["NEWSLETTER_DEPENDENCIES"],
        "--shared-wheel",
        os.environ["NEWSLETTER_PROTO_WHEEL"],
        "--shared-wheel",
        os.environ["NEWSLETTER_CLIENT_WHEEL"],
    ]
    smoke_wheel.main(install_runtime=install_bazel_runtime)
