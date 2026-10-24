"""Deployment settings and safe errors; values never enter logs."""

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

MODEL = "gpt-6.1-sol"
EFFORT = "medium"
SDK_VERSION = "0.163.0"


class RunnerError(Exception):
    """A fixed error code safe for status reports and logs."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Settings:
    url: str
    token: str = field(repr=False)
    codex_home: Path

    @classmethod
    def from_environment(cls) -> "Settings":
        url = os.environ.get("MAILSORT_URL", "").rstrip("/")
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            raise RunnerError("configuration")
        token_file = os.environ.get("MAILSORT_TOKEN_FILE")
        token = os.environ.get("MAILSORT_TOKEN", "")
        if token_file and token:
            raise RunnerError("configuration")
        if token_file:
            try:
                token = Path(token_file).read_text().strip()
            except OSError:
                raise RunnerError("configuration") from None
        if not token or len(token) > 4096 or any(ord(char) <= 32 for char in token):
            raise RunnerError("configuration")
        return cls(url, token, codex_home())


def codex_home() -> Path:
    """Require a dedicated writable auth directory without opening auth files."""
    path = Path(os.environ.get("CODEX_HOME", "/data/codex-auth")).absolute()
    if not path.is_dir() or path == Path.home() / ".codex":
        raise RunnerError("configuration")
    if any((path / name).exists() for name in ("config.toml", "AGENTS.md", "hooks.json")):
        raise RunnerError("configuration")
    return path
