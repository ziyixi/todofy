"""Prepare a venv and the Dockerfile's account from the declared OCI base."""

import argparse
import json
import tarfile
from pathlib import Path


def base_accounts(layout: Path) -> dict[str, str]:
    def blob(digest: str) -> Path:
        return layout / "blobs" / digest.replace(":", "/", 1)

    index = json.loads((layout / "index.json").read_text())
    manifest = json.loads(blob(index["manifests"][0]["digest"]).read_text())
    accounts = {}
    for layer in manifest["layers"]:
        with tarfile.open(blob(layer["digest"]), "r:*") as archive:
            for entry in archive:
                name = entry.name.removeprefix("./")
                if name in {"etc/passwd", "etc/group"}:
                    stream = archive.extractfile(entry)
                    if stream is None:
                        raise ValueError("Base account file is not regular")
                    accounts[name] = stream.read().decode()
    if accounts.keys() != {"etc/passwd", "etc/group"}:
        raise ValueError("Base account files are missing")
    return accounts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument(
        "--service", choices=("codex-gateway", "newsletter", "platform"), required=True
    )
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    application = (
        "personal-cloud/platform" if args.service == "platform" else args.service
    )
    venv = args.out / "opt" / application / ".venv"
    venv.mkdir(parents=True)
    (venv / "pyvenv.cfg").write_text(
        "home = /usr/local/bin\ninclude-system-site-packages = false\nversion = 3.14.7\n"
    )
    if args.service != "platform":
        accounts = base_accounts(args.base)
        account = args.service
        additions = {
            "etc/passwd": f"{account}:x:10001:10001::/home/{account}:/bin/sh\n",
            "etc/group": f"{account}:x:10001:\n",
        }
        for name, addition in additions.items():
            if any(
                line.split(":")[2] == "10001" for line in accounts[name].splitlines()
            ):
                raise ValueError("Base already owns the application account ID")
            output = args.out / name
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(accounts[name].rstrip("\n") + "\n" + addition)


if __name__ == "__main__":
    main()
