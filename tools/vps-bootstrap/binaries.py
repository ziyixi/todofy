"""Checksum-pinned official host tools; never replace the existing SSH connector."""

import tempfile
import time
import urllib.request
from pathlib import Path

import host

from config import checksum, require

CONNECTOR = Path("/usr/local/libexec/personal-cloud/cloudflared")


def pinned_binary(path, url, expected, conflict_code):
    path = host.real_path(path)
    if path.exists():
        require(path.is_file() and checksum(path) == expected, conflict_code)
        return
    require(path.parent.is_dir(), "BINARY_DIRECTORY_INVALID")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 600
    with tempfile.NamedTemporaryFile(
        dir=path.parent, prefix=".personal-cloud-binary-", delete=False
    ) as target:
        temporary = Path(target.name)
        try:
            with opener.open(url, timeout=30) as response:
                require(
                    response.geturl().startswith("https://"), "BINARY_SOURCE_INVALID"
                )
                length = 0
                while chunk := response.read(65536):
                    length += len(chunk)
                    require(
                        length <= 200 * 1024 * 1024 and time.monotonic() < deadline,
                        "BINARY_DOWNLOAD_TOO_LARGE",
                    )
                    target.write(chunk)
            target.flush()
            require(checksum(temporary) == expected, "BINARY_CHECKSUM_MISMATCH")
            host.write_file(path, temporary.read_bytes(), mode=0o755)
        finally:
            temporary.unlink(missing_ok=True)


def connector_preflight(versions):
    path = host.real_path(CONNECTOR)
    for directory in path.parents:
        if directory.exists():
            attributes = directory.stat()
            require(
                directory.is_dir()
                and attributes.st_uid == 0
                and attributes.st_mode & 0o022 == 0
                and attributes.st_mode & 0o001 != 0,
                "CONNECTOR_DIRECTORY_INVALID",
            )
    if path.exists():
        attributes = path.stat()
        require(
            path.is_file()
            and attributes.st_uid == 0
            and attributes.st_mode & 0o7777 == 0o755
            and checksum(path) == versions["cloudflared"]["linux_amd64_sha256"],
            "FOREIGN_PLATFORM_CONNECTOR",
        )
    return str(path)


def install_connector(versions):
    connector_preflight(versions)
    # This project-owned directory is independent of /usr/bin/cloudflared,
    # /usr/local/bin/cloudflared and all existing connector services.
    missing = []
    parent = CONNECTOR.parent
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    for directory in reversed(missing):
        host.directory(directory, mode=0o755)
    pinned = versions["cloudflared"]
    url = (
        "https://github.com/cloudflare/cloudflared/releases/download/"
        + pinned["version"]
        + "/cloudflared-linux-amd64"
    )
    pinned_binary(
        CONNECTOR, url, pinned["linux_amd64_sha256"], "FOREIGN_PLATFORM_CONNECTOR"
    )
    connector_preflight(versions)
