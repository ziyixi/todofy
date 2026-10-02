"""The ops-v1 stack for runtime tests: a test-only dashboard stand-in in front of the real
gateway and core, in one `pywrangler dev` process (never shipped).

The dashboard Worker that will call ``Ops`` does not exist yet, so the probe plays it: a JS
primary with the two service bindings a dashboard would have to the gateway, ``OPS``
(``entrypoint = "Ops"``, the ops-v1 RPC surface) and ``GATEWAY`` (the default entrypoint).
``POST /__ops/<method>`` with a JSON list of arguments calls the method over the binding and
answers ``{"ok": value}`` or ``{"error": message}`` (a rejection's message, i.e. an
OpsErrorCode); ``POST /__intents/<method>`` does the same over ``INTENTS``, the watch app's binding
(``entrypoint = "Intents"``, ``props = { source = "watch" }``); every other request goes on to the
gateway unchanged, so the harness's
``/health`` wait, the webhook and the owner API work as with ``start_gateway``.

The primary owns ``--var``, so the gateway's test config is generated with its vars merged in
(next to the committed one, so its relative paths hold), like the core's (harness.py).
"""

import json
import tomllib
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import jsonschema

from tests.runtime.harness import CORE_CONFIG, GATEWAY_CONFIG, GATEWAY_VARS, ROOT, SHARED_VARS, Worker, _run

CONTRACT = ROOT.parent / "contracts" / "ops-v1"
SCHEMA = json.loads((CONTRACT / "ops-v1.schema.json").read_text())

PROBE_SCRIPT = """\
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, prefix, method] = url.pathname.split('/');
    const binding = prefix === '__ops' ? env.OPS : prefix === '__intents' ? env.INTENTS : null;
    if (binding === null) return env.GATEWAY.fetch(request);
    const args = JSON.parse((await request.text()) || '[]');
    try {
      return Response.json({ ok: await binding[method](...args) });
    } catch (error) {
      return Response.json({ error: String(error && error.message), name: String(error && error.name) });
    }
  },
};
"""
PROBE_CONFIG = """\
name = "todofy-ops-probe"
main = "probe.js"
compatibility_date = "2026-09-08"
workers_dev = false
preview_urls = false

[[services]]
binding = "OPS"
service = "{gateway}"
entrypoint = "Ops"

[[services]]
binding = "INTENTS"
service = "{gateway}"
entrypoint = "Intents"
props = { source = "watch" }

[[services]]
binding = "GATEWAY"
service = "{gateway}"
"""


def schema_errors(definition: str, value: Any) -> list[str]:
    """Errors of ``value`` against ``$defs[definition]`` of contracts/ops-v1 (reference validator)."""
    validator = jsonschema.Draft202012Validator({**SCHEMA, "$ref": f"#/$defs/{definition}"})
    return [f"{list(error.absolute_path)}: {error.message}" for error in validator.iter_errors(value)]


class OpsStack(Worker):
    """A Worker whose ``ops(method, *args)`` calls the gateway's Ops entrypoint over RPC."""

    def ops(self, method: str, *args: Any) -> dict[str, Any]:
        response = self.hooks.post(f"/__ops/{method}", content=json.dumps(args))
        assert response.status_code == 200, response.text
        return response.json()

    def intents(self, method: str, *args: Any) -> dict[str, Any]:
        """The method over the watch app's binding: entrypoint ``Intents`` with ``props.source = "watch"``."""
        response = self.hooks.post(f"/__intents/{method}", content=json.dumps(args))
        assert response.status_code == 200, response.text
        return response.json()

    def ok(self, method: str, *args: Any, definition: str) -> dict[str, Any]:
        """The method's value, which must validate against ``definition``."""
        answer = self.ops(method, *args)
        assert "ok" in answer, answer
        assert schema_errors(definition, answer["ok"]) == [], answer["ok"]
        return answer["ok"]


def start_ops_stack(state: Path, variables: dict[str, str]) -> Iterator[OpsStack]:
    """The probe (primary), the gateway and todofy-core in one process, with ``variables`` split
    between the gateway and the core as ``start_gateway`` splits them."""
    shared = {name: value for name, value in variables.items() if name in SHARED_VARS}
    gateway_vars = {name: value for name, value in variables.items() if GATEWAY_VARS.fullmatch(name)} | shared
    core_vars = {name: value for name, value in variables.items() if name not in gateway_vars} | shared

    gateway = tomllib.loads((ROOT / GATEWAY_CONFIG).read_text())
    gateway["vars"] |= gateway_vars
    core = tomllib.loads(CORE_CONFIG.read_text())
    core["vars"] |= core_vars
    run = uuid.uuid4().hex
    gateway_path = ROOT / "gateway" / f"wrangler.test-run-{run}.json"
    core_path = ROOT / f"wrangler.test-run-{run}.json"
    (state / "probe.js").write_text(PROBE_SCRIPT)
    (state / "wrangler.toml").write_text(PROBE_CONFIG.replace("{gateway}", gateway["name"]))
    gateway_path.write_text(json.dumps(gateway))
    core_path.write_text(json.dumps(core))
    configs = [str(state / "wrangler.toml"), str(gateway_path.relative_to(ROOT)), core_path.name]
    try:
        yield from _run(OpsStack(configs, core_path.name, state, {}))
    finally:
        gateway_path.unlink(missing_ok=True)
        core_path.unlink(missing_ok=True)
