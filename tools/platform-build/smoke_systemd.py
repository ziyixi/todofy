"""Exercise the actual Linux probe image without a host bus or application credentials."""

import os
import stat

from personal_cloud.observer import systemd_snapshot


def main():
    assert os.geteuid() == 65534 and os.getegid() == 10001
    assert systemd_snapshot.main() == 0
    metadata = systemd_snapshot.SNAPSHOT_PATH.stat()
    assert stat.S_IMODE(metadata.st_mode) == 0o640
    assert metadata.st_size <= systemd_snapshot.MAX_BYTES
    assert systemd_snapshot.read() == {
        name: {"state": "unknown"} for name in systemd_snapshot.UNITS
    }
    print(
        "Systemd probe image smoke passed; live bus authorization remains unverified."
    )


if __name__ == "__main__":
    main()
