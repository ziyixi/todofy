"""Bind collection directions to their frozen public source guides."""

import pathlib

import newsletter.collection.instructions as newsletter_collection_instructions
import newsletter.contracts as contracts

MAX_GUIDE_BYTES = 16_000
_GUIDES = {"01-ai-ml": "ai-ml.md"}


def load_discovery_instructions(
    directory: pathlib.Path,
) -> list[newsletter_collection_instructions.Instruction]:
    """An optional _sources file augments its direction, not the worker count.

    Old custom instruction directories need no migration. Source-guide edits
    affect the next frozen run only; ordinary execution consumes that snapshot.
    """
    instructions = newsletter_collection_instructions.load_instructions(
        directory
    )
    result = []
    for instruction in instructions:
        name = _GUIDES.get(instruction.id)
        if name is None:
            result.append(instruction)
            continue
        folder = directory / "_sources"
        path = folder / name
        try:
            if folder.is_symlink() or path.is_symlink():
                raise newsletter_collection_instructions.InstructionError()
            if not folder.exists():
                result.append(instruction)
                continue
            if not folder.is_dir():
                raise newsletter_collection_instructions.InstructionError()
            if not path.exists():
                result.append(instruction)
                continue
            if not path.is_file():
                raise newsletter_collection_instructions.InstructionError()
            with path.open("rb") as source:
                raw = source.read(MAX_GUIDE_BYTES + 1)
            guide = raw.decode("utf-8")
            if (
                len(raw) > MAX_GUIDE_BYTES
                or not guide.strip()
                or "\x00" in guide
            ):
                raise newsletter_collection_instructions.InstructionError()
            text = (
                instruction.text
                + "\n\n## Frozen public source guide\n\n"
                + guide
            )
            if (
                len(text.encode("utf-8"))
                > newsletter_collection_instructions.MAX_INSTRUCTION_BYTES
            ):
                raise newsletter_collection_instructions.InstructionError()
            result.append(
                newsletter_collection_instructions.Instruction(
                    instruction.id, text, contracts.content_hash(text)
                )
            )
        except (OSError, UnicodeError):
            raise (
                newsletter_collection_instructions.InstructionError()
            ) from None
    return result
