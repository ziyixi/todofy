"""Read local composite steps for the repository's existing workflow safety tests.

This is a test reader, not a workflow generator or a GitHub expression interpreter.
Only explicit local action calls, scalar inputs and exact app selectors are expanded. Native job gates,
permissions and concurrency remain in the real workflow and are tested separately.
"""

import re
from pathlib import Path

ROOT = Path(__file__).absolute().parents[2]


def workflow_data(path):
    import yaml

    # BaseLoader keeps Actions keys such as `on` and expression values as strings.
    # It only constructs dictionaries, lists and strings, never Python objects.
    return yaml.load(path.read_text(), Loader=yaml.BaseLoader)


def jobs(text):
    body = text.split("\njobs:\n", 1)[1]
    parts = re.split(r"^  ([a-z][a-z0-9-]*):\n", body, flags=re.M)
    return dict(zip(parts[1::2], parts[2::2], strict=True))


def steps(body):
    return ["      - " + part for part in re.split(r"^      - ", body, flags=re.M)[1:]]


def expand_actions(block, root=ROOT):
    """Expose action steps at workflow indentation, resolving their explicit inputs."""
    if "    steps:\n" not in block:
        return block
    header, body = block.split("    steps:\n", 1)
    expanded = []
    for step in steps(body):
        call = re.search(
            r"^        uses: (\./\.github/actions/[a-z0-9-]+)$", step, re.M
        )
        if not call:
            expanded.append(step)
            continue
        action = (root / call.group(1) / "action.yml").read_text()
        values = dict(re.findall(r"^          ([a-z0-9-]+): (.+)$", step, re.M))
        inner = action.split("  steps:\n", 1)[1]
        inner = (
            "\n".join("  " + line if line else line for line in inner.splitlines())
            + "\n"
        )

        def substitute(match):
            key = match.group(1)
            if key not in values:
                raise ValueError(f"Unresolved action input: {call.group(1)} / {key}")
            return values[key]

        inner = re.sub(
            r"\$\{\{ fromJSON\(inputs\.([a-z0-9-]+)\) \}\}", substitute, inner
        )
        inner = re.sub(r"\$\{\{ inputs\.([a-z0-9-]+) \}\}", substitute, inner)
        # The release action's guard is a bare expression; other inputs are full expressions.
        if "inputs.required" in inner:
            required = values["required"]
            inner = inner.replace(
                "inputs.required", required.removeprefix("${{ ").removesuffix(" }}")
            )
        guard = re.search(r"^        if: (.+)$", step, re.M)
        if guard:
            # The shared installer has no per-step guard; its composite call supplies it.
            guarded = []
            for child in steps(inner):
                if not re.search(r"^        if:", child, re.M):
                    first, rest = child.split("\n", 1)
                    child = first + "\n        if: " + guard.group(1) + "\n" + rest
                guarded.append(child)
            inner = "".join(guarded)
        # Composite actions can share the small workspace installer.
        inner = expand_actions("    steps:\n" + inner, root).split("    steps:\n", 1)[1]
        expanded.append(inner)
    return header + "    steps:\n" + "".join(expanded)


def release_jobs():
    """One concrete view per app, for the existing app-specific safety assertions."""
    block = jobs((ROOT / ".github/workflows/worker-release.yml").read_text())["release"]
    header, body = block.split("    steps:\n", 1)
    calls = steps(body)
    result = {}
    for call in calls:
        app_match = re.search(r"uses: \./\.github/actions/release-([a-z-]+)", call)
        if not app_match:
            continue
        app = app_match.group(1)
        selected = []
        for step in calls:
            if ".github/actions/release-" in step and step != call:
                continue
            target = re.search(r"^        if: inputs.app == '([a-z-]+)'$", step, re.M)
            if target and target.group(1) != app:
                continue
            selected.append(step)
        concrete = header.replace("${{ inputs.app }}", app)
        concrete = re.sub(
            r"^      url: .*",
            "      url: ${{ steps.config.outputs.url }}",
            concrete,
            flags=re.M,
        )
        concrete = concrete.replace(
            "${{ inputs.app == 'website-relay' && 10 || 15 }}",
            "10" if app == "website-relay" else "15",
        )
        result[app + "-deploy"] = expand_actions(
            concrete + "    steps:\n" + "".join(selected)
        )
    return result


def effective_ci():
    source = (ROOT / ".github/workflows/ci.yml").read_text()
    releases = release_jobs()
    for name, caller in jobs(source).items():
        if "uses: ./.github/workflows/worker-release.yml" in caller:
            checked = caller.split("    permissions:\n", 1)[0]
            recipe = "    runs-on:" + releases[name].split("    runs-on:", 1)[1]
            # Shell fixtures run against their fixture root, not a nested source checkout.
            recipe = recipe.replace(".release-source/", "").replace(
                "working-directory: .release-source\n", "working-directory: .\n"
            )
            replacement = checked + recipe
        else:
            replacement = expand_actions(caller)
        source = source.replace(
            "  " + name + ":\n" + caller, "  " + name + ":\n" + replacement
        )
    return source
