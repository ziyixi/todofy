#!/usr/bin/env python3
"""Structural guard for infra/: python3 .github/scripts/infra_guard.py [infra-dir]

A small HCL reader (comments, strings with ${...}, heredocs, quoted or bare block labels, nested blocks),
not a regex over lines, so `resource terraform_data x { provisioner local-exec {...} }` with bare labels
is seen exactly like its quoted form. It fails closed: text it cannot read is a problem, not a pass.
Used by test_infra_config.py (Changes job, every push) and runnable on its own. Standard library only.

What it keeps true (infra/README.md "Scope" and "Next steps"):
- Files: only the committed kinds infra/ needs (*.tf, the lock file, docs, the example values, the
  scripts and their tests). No *.tofu / *.tf.json / *.tofu.json (OpenTofu would load them too), and no
  state, plan or values file of any name.
- Top-level blocks: terraform, provider "cloudflare", variable, locals, resource, import, output, moved.
  No data source (also not inside a check block), module, check, ephemeral or removed block.
- No provisioner or connection block anywhere (terraform_data/null_resource are not allowed types either).
- Every resource is one of ALLOWED_TYPES and has its own lifecycle { prevent_destroy = true }.
- No `moved` block names a FROZEN address (from or to, any instance key): a rename must not carry a write to a frozen
  object past the apply's gate (infra_state.py FROZEN_OBJECTS, which also matches by object id).
- No output reads a variable (var.*): outputs are printed by `tofu output` and compared with the public
  wrangler.toml files, so a personal value (the policies' emails) must never become one. Outputs read managed
  objects only (outputs.tf).
- A backend or cloud block is only allowed together with an encryption block that enforces both state
  and plan encryption, and a sensitive state_passphrase variable. That block has no fallback and no
  unencrypted method, and every key_provider's passphrase is exactly var.state_passphrase.
"""

from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

# The monorepo boundary (owner rule 2026-10-01). Adding a type here is a deliberate scope decision.
ALLOWED_TYPES = frozenset({
    "cloudflare_zero_trust_access_application",
    "cloudflare_zero_trust_access_policy",
    "cloudflare_d1_database",
    "cloudflare_r2_bucket",
    "cloudflare_zero_trust_access_service_token",
    "cloudflare_zero_trust_tunnel_cloudflared",
    "cloudflare_zero_trust_tunnel_cloudflared_config",
    "cloudflare_dns_record",
    "cloudflare_zero_trust_access_identity_provider",
    "cloudflare_email_routing_rule",
})
# New network resources are scoped by address as well as type. No unrelated DNS or tunnel is managed.
PLATFORM_OBJECTS = frozenset({
    "cloudflare_zero_trust_access_service_token.platform_deploy",
    "cloudflare_zero_trust_tunnel_cloudflared.platform",
    "cloudflare_zero_trust_tunnel_cloudflared_config.platform",
    "cloudflare_dns_record.platform",
    "cloudflare_zero_trust_access_identity_provider.github",
    "cloudflare_zero_trust_access_identity_provider.email",
    "cloudflare_email_routing_rule.mail_hero",
})
PLATFORM_TYPES = frozenset(address.split(".", 1)[0] for address in PLATFORM_OBJECTS)

# Addresses an apply never writes to (infra_state.py FROZEN; test_infra_config.py keeps the two equal).
FROZEN = frozenset({"cloudflare_zero_trust_access_application.mail_hero_backup"})
TOP_LEVEL = frozenset({"terraform", "provider", "variable", "locals", "resource", "import", "output", "moved"})
NEVER_NESTED = frozenset({"provisioner", "connection", "data", "module", "resource"})
# Committed files under infra/, relative to it. Anything else (a plan named tfplan or plan.out, a .tofu
# file, a log) fails, whatever its name.
ALLOWED_FILES = re.compile(
    r"^(?:[A-Za-z0-9_-]+\.tf|\.terraform\.lock\.hcl|\.gitignore|README\.md|local\.tfvars\.example"
    r"|scripts/[A-Za-z0-9_]+\.py|tests/[A-Za-z0-9_]+\.py)$"
)
OTHER_CONFIG = ("*.tofu", "*.tf.json", "*.tofu.json")
# The only passphrase expression allowed in the encryption block: never a literal, never another variable.
PASSPHRASE_REFERENCE = [("ID", "var"), ("P", "."), ("ID", "state_passphrase")]


class ParseError(ValueError):
    pass


@dataclass
class Block:
    type: str
    labels: list[str]
    line: int
    attrs: dict[str, list[tuple[str, str]]] = field(default_factory=dict)
    blocks: list["Block"] = field(default_factory=list)

    def children(self, kind: str) -> list["Block"]:
        return [block for block in self.blocks if block.type == kind]

    def is_true(self, name: str) -> bool:
        return self.attrs.get(name) == [("ID", "true")]

    def walk(self):
        for block in self.blocks:
            yield block
            yield from block.walk()


_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*")
_NUMBER = re.compile(r"[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
_HEREDOC = re.compile(r"<<-?([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\r?\n")
_OPS = ("==", "!=", "<=", ">=", "&&", "||", "=>", "...")


def _string_end(text: str, i: int) -> int:
    """Index just past the closing quote of the string starting at text[i] == '"'."""
    j = i + 1
    while j < len(text):
        if text[j] == "\\":
            j += 2
        elif text[j] == '"':
            return j + 1
        elif text[j] == "\n":
            break
        elif text.startswith(("$${", "%%{"), j):
            j += 3
        elif text.startswith(("${", "%{"), j):
            j = _template_end(text, j + 2)
        else:
            j += 1
    raise ParseError("unterminated string")


def _template_end(text: str, j: int) -> int:
    depth = 1
    while j < len(text):
        if text[j] == '"':
            j = _string_end(text, j)
            continue
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    raise ParseError("unterminated template interpolation")


def tokenize(text: str) -> list[tuple[str, str, int]]:
    tokens, i, line = [], 0, 1
    while i < len(text):
        c = text[i]
        if c in " \t\r":
            i += 1
        elif c == "\n":
            tokens.append(("NL", "\n", line))
            line += 1
            i += 1
        elif c == "#" or text.startswith("//", i):
            end = text.find("\n", i)
            i = len(text) if end < 0 else end
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end < 0:
                raise ParseError("unterminated comment")
            line += text.count("\n", i, end)
            i = end + 2
        elif c == '"':
            end = _string_end(text, i)
            tokens.append(("STR", text[i:end], line))
            i = end
        elif (heredoc := _HEREDOC.match(text, i)) is not None:
            marker = re.compile(rf"(?m)^[ \t]*{re.escape(heredoc.group(1))}[ \t]*$")
            close = marker.search(text, heredoc.end())
            if close is None:
                raise ParseError("unterminated heredoc")
            tokens.append(("HEREDOC", text[i:close.end()], line))
            line += text.count("\n", i, close.end())
            i = close.end()
        elif (word := _IDENT.match(text, i)) is not None:
            tokens.append(("ID", word.group(), line))
            i = word.end()
        elif (number := _NUMBER.match(text, i)) is not None:
            tokens.append(("NUM", number.group(), line))
            i = number.end()
        else:
            op = next((op for op in _OPS if text.startswith(op, i)), c)
            tokens.append(("P", op, line))
            i += len(op)
    return tokens


def _label(token: tuple[str, str, int]) -> str:
    kind, value, _ = token
    return value[1:-1] if kind == "STR" else value


def _body(tokens, i: int, block: Block, closing: bool) -> int:
    while True:
        while i < len(tokens) and tokens[i][0] == "NL":
            i += 1
        if i >= len(tokens):
            if closing:
                raise ParseError(f"block {block.type} opened on line {block.line} is not closed")
            return i
        kind, value, line = tokens[i]
        if (kind, value) == ("P", "}"):
            if not closing:
                raise ParseError(f"unexpected }} on line {line}")
            return i + 1
        if kind != "ID":
            raise ParseError(f"expected an attribute or block name on line {line}")
        i += 1
        if i < len(tokens) and tokens[i][:2] == ("P", "="):
            i += 1
            start, depth = i, 0
            while i < len(tokens):
                k, v, _ = tokens[i]
                if k == "P" and v in "([{":
                    depth += 1
                elif k == "P" and v in ")]}":
                    if depth == 0:
                        break
                    depth -= 1
                elif k == "NL" and depth == 0:
                    break
                i += 1
            if depth:
                raise ParseError(f"unbalanced expression for {value} on line {line}")
            block.attrs[value] = [(k, v) for k, v, _ in tokens[start:i]]
            continue
        labels = []
        while i < len(tokens) and tokens[i][0] in ("STR", "ID"):
            labels.append(_label(tokens[i]))
            i += 1
        if i >= len(tokens) or tokens[i][:2] != ("P", "{"):
            raise ParseError(f"expected {{ after block {value} on line {line}")
        child = Block(value, labels, line)
        i = _body(tokens, i + 1, child, closing=True)
        block.blocks.append(child)


def parse(text: str) -> Block:
    root = Block("<file>", [], 0)
    _body(tokenize(text), 0, root, closing=False)
    return root


_VAR_IN_TEMPLATE = re.compile(r"[$%]\{[^}]*\bvar\.")


def _reads_a_variable(block: Block) -> bool:
    """Any `var.` in the block's attributes (also in nested blocks and inside "${...}" templates)."""
    for node in (block, *block.walk()):
        for tokens in node.attrs.values():
            for kind, value in tokens:
                if (kind, value) == ("ID", "var") or (kind in ("STR", "HEREDOC") and _VAR_IN_TEMPLATE.search(value)):
                    return True
    return False


def _reference(tokens: list[tuple[str, str]]) -> str:
    """The resource address an attribute names, without its instance key: `a.b["k"]` -> `a.b`."""
    text = ""
    for kind, value in tokens:
        if (kind, value) == ("P", "["):
            break
        text += value
    return text


def committed_files(infra: Path) -> list[str] | None:
    """Tracked plus untracked-but-not-ignored files under infra/, relative to it; None outside a git tree."""
    try:
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "--", "."],
            cwd=infra, capture_output=True, text=True, check=True,
        )
        prefix = subprocess.run(
            ["git", "rev-parse", "--show-prefix"], cwd=infra, capture_output=True, text=True, check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    return sorted({line[len(prefix):] for line in result.stdout.splitlines() if line.startswith(prefix)})


def check(infra: Path) -> list[str]:
    """Every problem found under infra/ (empty when it is within the boundary). Messages never quote values."""
    problems = []
    files = committed_files(infra)
    if files is None:
        files = sorted(
            path.relative_to(infra).as_posix() for path in infra.rglob("*")
            if path.is_file() and not {".terraform", "__pycache__"} & set(path.relative_to(infra).parts)
        )
    problems += [f"{name}: not a file kind infra/ may hold" for name in files if not ALLOWED_FILES.match(name)]
    for pattern in OTHER_CONFIG:  # even ignored ones: OpenTofu loads them locally all the same
        problems += [f"{path.name}: OpenTofu would load this file; infra/ uses *.tf only" for path in infra.glob(pattern)]

    roots = {}
    for path in sorted(infra.glob("*.tf")):
        try:
            roots[path.name] = parse(path.read_text(encoding="utf-8"))
        except (ParseError, UnicodeDecodeError) as error:
            problems.append(f"{path.name}: cannot be read by the guard ({error}); fix the syntax")
    if not roots:
        problems.append("no *.tf file found")

    terraform, variables, resources = [], {}, 0
    for name, root in roots.items():
        for block in root.blocks:
            where = f"{name}:{block.line}"
            if block.type not in TOP_LEVEL:
                problems.append(f"{where}: top-level block {block.type} is not allowed in infra/")
            if block.type == "terraform":
                terraform.append(block)
            elif block.type == "variable" and block.labels:
                variables[block.labels[0]] = block
            elif block.type == "provider" and block.labels != ["cloudflare"]:
                problems.append(f"{where}: only the cloudflare provider is configured here")
            elif block.type == "resource":
                resources += 1
                if (len(block.labels) != 2 or block.labels[0] not in ALLOWED_TYPES
                    or (block.labels[0] in PLATFORM_TYPES and ".".join(block.labels) not in PLATFORM_OBJECTS)):
                    problems.append(f"{where}: resource type outside the monorepo boundary (ALLOWED_TYPES)")
                lifecycles = block.children("lifecycle")
                if len(lifecycles) != 1 or not lifecycles[0].is_true("prevent_destroy"):
                    problems.append(f"{where}: resource without its own lifecycle {{ prevent_destroy = true }}")
            if block.type == "output" and block.labels == ["platform_bootstrap"] and not block.is_true("sensitive"):
                problems.append(f"{where}: platform bootstrap output must be sensitive")
            counted_backup = (block.attrs.get("from") == [("ID", "cloudflare_zero_trust_access_application"), ("P", "."), ("ID", "mail_hero_backup")]
                              and block.attrs.get("to") == [("ID", "cloudflare_zero_trust_access_application"), ("P", "."), ("ID", "mail_hero_backup"), ("P", "["), ("NUM", "0"), ("P", "]")])
            if (block.type == "moved" and not counted_backup
                    and any(_reference(block.attrs.get(side, [])) in FROZEN for side in ("from", "to"))):
                problems.append(f"{where}: a moved block names a FROZEN address; it must never be renamed")
            if block.type == "output" and _reads_a_variable(block):
                problems.append(f"{where}: an output reads a variable; outputs read managed objects only")
            for nested in block.walk():
                kinds = {nested.type} | ({nested.labels[0]} if nested.type == "dynamic" and nested.labels else set())
                if kinds & NEVER_NESTED:
                    problems.append(f"{where}: nested {'/'.join(sorted(kinds & NEVER_NESTED))} block is not allowed")
    if roots and not resources:
        problems.append("no resource found")

    backends = [b for t in terraform for b in t.blocks if b.type in ("backend", "cloud")]
    if backends:
        encryption = [b for t in terraform for b in t.children("encryption")]
        enforced = len(encryption) == 1 and all(
            len(encryption[0].children(kind)) == 1
            and encryption[0].children(kind)[0].is_true("enforced")
            and "method" in encryption[0].children(kind)[0].attrs
            for kind in ("state", "plan")
        )
        if not enforced:
            problems.append("a backend is configured without one encryption block enforcing both state and plan")
        for block in encryption:
            nested = [block, *block.walk()]
            if any(b.type == "fallback" for b in nested):
                problems.append("the encryption block has a fallback: state or plans could be read unencrypted")
            if any(b.type == "method" and b.labels[:1] == ["unencrypted"] for b in nested):
                problems.append("the encryption block declares the unencrypted method")
            for provider in block.children("key_provider"):
                if provider.attrs.get("passphrase") != PASSPHRASE_REFERENCE:
                    problems.append("a key_provider passphrase is not exactly var.state_passphrase")
        passphrase = variables.get("state_passphrase")
        if passphrase is None or not passphrase.is_true("sensitive"):
            problems.append("a backend is configured without a sensitive state_passphrase variable")
    return problems


def main(argv: list[str]) -> int:
    infra = Path(argv[1] if len(argv) > 1 else Path(__file__).resolve().parents[2] / "infra")
    problems = check(infra)
    for problem in problems:
        print(f"infra_guard: {problem}", file=sys.stderr)
    if not problems:
        print("infra_guard: ok")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
