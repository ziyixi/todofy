"""The golden answers in contracts/newsletter-ui-v1/fixtures are these bytes.

The console Worker passes Newsletter's answers through unparsed, so the bytes
the listener writes must be the bytes TypeScript's codec writes for the same
message: proto/test/newsletter-ui.test.ts reads each fixture back and writes it
again; here the reader writes them, and Python's codec reads them back.
"""

import importlib.util as util
import json
import pathlib

import pytest
import ziyixi_proto.newsletter.ui.v1.newsletter_ui_service_pb as service_pb
import ziyixi_proto.wire_json as wire_json

import newsletter.console_api as console_api
import tests.support.console_world as console_world

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "contracts" / "newsletter-ui-v1" / "fixtures"
_OUTPUTS = {
    binding.rpc: binding.response for binding in service_pb.HTTP_BINDINGS
}
TYPES = {
    "overview": _OUTPUTS["GetOverview"],
    "runs": _OUTPUTS["ListRuns"],
    "run-blocked-selection-timeout": _OUTPUTS["GetRun"],
    "run-ready": _OUTPUTS["GetRun"],
    "model-calls": _OUTPUTS["ListModelCalls"],
    "model-usage-30d": _OUTPUTS["SummarizeModelUsage"],
    "editions": _OUTPUTS["ListEditions"],
    "edition": _OUTPUTS["GetEdition"],
    "edition-rendering": _OUTPUTS["GetEditionRendering"],
    "source-catalog": _OUTPUTS["GetSourceCatalog"],
    "backup-status": _OUTPUTS["GetBackupStatus"],
}


@pytest.fixture(scope="module")
def generated():
    # The same generator as scripts/console_fixtures.py, imported by path:
    # scripts/ is not a package.
    spec = util.spec_from_file_location(
        "console_fixtures", ROOT / "newsletter/scripts/console_fixtures.py"
    )
    module = util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.generate()


def test_every_fixture_is_the_readers_bytes(generated):
    assert set(generated) == set(TYPES)
    assert sorted(p.stem for p in FIXTURES.glob("*.json")) == sorted(TYPES)
    for name, body in generated.items():
        assert (FIXTURES / f"{name}.json").read_bytes() == body, (
            f"{name}.json is stale: run scripts/console_fixtures.py --update"
        )


@pytest.mark.parametrize("name", sorted(TYPES))
def test_each_fixture_reads_back_strictly_and_writes_the_same(name):
    text = (FIXTURES / f"{name}.json").read_bytes()
    assert not text.endswith(b"\n")
    read = wire_json.from_wire(TYPES[name], json.loads(text), strict=True)
    assert read.unrecognized == []
    assert console_api.encode(read.message) == text


def test_the_fixtures_name_no_real_value():
    text = "".join(p.read_text() for p in FIXTURES.glob("*.json"))
    assert "@" not in text.replace("owner@example.invalid", "")
    for identifier in (
        console_world.RUN_28,
        console_world.EDITION_27,
        console_world.NEW_REVISION,
    ):
        assert identifier in text
