"""Compile the observer policy with the host's real parser without loading it into the kernel."""

import subprocess
import sys

# A missing parser fails: only the Ubuntu host provides the abi/3.0 and tunables includes.
subprocess.run(
    [
        "/usr/sbin/apparmor_parser",
        "--skip-kernel-load",
        "--skip-cache",
        "--quiet",
        sys.argv[1],
    ],
    check=True,
)
