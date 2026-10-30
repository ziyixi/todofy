"""Extract the one declared font used by Newsletter's offline rendering tests."""

import sys
import tarfile
from pathlib import Path

with tarfile.open(sys.argv[1], "r:xz") as archive:
    source = archive.extractfile(
        "./usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
    )
    if source is None:
        raise ValueError("The fixed Debian package is missing the CJK test font")
    Path(sys.argv[2]).write_bytes(source.read())
