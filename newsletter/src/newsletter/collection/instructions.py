"""Load bounded operator Markdown as data, not executable skills."""

import dataclasses
import pathlib
import re

import newsletter.contracts as contracts

MAX_DIRECTIONS = 8
MAX_INSTRUCTION_BYTES = 24_000


class InstructionError(ValueError):
    """A bounded operator instruction directory could not be validated."""

    def __init__(self) -> None:
        super().__init__(
            "Instructions must be 1..8 nonempty UTF-8 Markdown files in a "
            "real directory"
        )


@dataclasses.dataclass(frozen=True)
class Instruction:
    """One immutable collection direction and the hash of its original text."""

    id: str
    text: str
    digest: str

    def snapshot(self) -> dict[str, str]:
        """Return the exact fields persisted when accepting a new run."""
        return dataclasses.asdict(self)


def load_instructions(directory: pathlib.Path) -> list[Instruction]:
    """Sorted top-level *.md only; README/_notes do not become collection jobs.

    No recursion, symlinks, dynamic imports, templating or shell execution.
    The caller persists these exact bytes before accepting a trigger.
    """
    try:
        absolute = directory.absolute()
        if (
            any(p.is_symlink() for p in (absolute, *absolute.parents))
            or not absolute.is_dir()
        ):
            raise InstructionError()
        entries = sorted(absolute.iterdir(), key=lambda p: p.name)
        selected = [
            p
            for p in entries
            if p.suffix == ".md"
            and p.stem != "README"
            and not p.name.startswith("_")
        ]
        if not 1 <= len(selected) <= MAX_DIRECTIONS:
            raise InstructionError()
        result = []
        for path in selected:
            if (
                path.is_symlink()
                or not path.is_file()
                or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", path.stem)
            ):
                raise InstructionError()
            with path.open("rb") as source:
                raw = source.read(MAX_INSTRUCTION_BYTES + 1)
            text = raw.decode("utf-8")
            if (
                not text.strip()
                or len(raw) > MAX_INSTRUCTION_BYTES
                or "\x00" in text
            ):
                raise InstructionError()
            result.append(
                Instruction(path.stem, text, contracts.content_hash(text))
            )
        return result
    except (OSError, UnicodeError):
        raise InstructionError() from None
