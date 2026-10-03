"""Public immutable release identity shared by offline manifest rendering and the Actions HTTP client."""

import hashlib
import re
import sys
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "cloud-config"))
from cloud_profile import load_profile


def release_id(sha: str) -> str:
    """Same verified source SHA retains the existing canonical UUID4 across network retries."""
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Invalid source identity")
    digest = hashlib.sha256(("personal-cloud-release-v1:" + sha).encode()).digest()
    return str(UUID(bytes=digest[:16], version=4))


def resume_id(name: str, etag: str) -> str:
    """An explicit continuation of the same observed revision retains its request identity."""
    digest = hashlib.sha256(
        ("personal-cloud-resume-v1:" + name + ":" + etag).encode()
    ).digest()
    return str(UUID(bytes=digest[:16], version=4))


def verified_images(
    root: Path, sha: str, images: dict[str, str]
) -> tuple[dict, dict[str, str]]:
    """Accept only this profile owner's two fixed published images, both pinned by full SHA256."""
    profile = release_profile(root, sha)
    if set(images) != {"newsletter", "platform"}:
        raise ValueError("Invalid release images")
    owner = profile["repository"].split("/")[0]
    digests = {}
    for service, image in images.items():
        if not isinstance(image, str) or not re.fullmatch(
            rf"ghcr\.io/{re.escape(owner)}/todofy-{service}@sha256:[0-9a-f]{{64}}",
            image,
        ):
            raise ValueError("Invalid verified image")
        digests["platform-runtime" if service == "platform" else service] = image.split(
            "@", 1
        )[1]
    return profile, digests


def release_profile(root: Path, sha: str) -> dict:
    """Both create and resume use the same validated public origin and canonical source identity."""
    release_id(sha)
    return load_profile(root)
