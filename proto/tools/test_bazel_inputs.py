"""The Bazel adapter preserves authoritative generator options and rejects unsupported plugin changes."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml
from bazel_codegen import main, typescript_template

CONFIG = Path(__file__).absolute().parents[1] / "buf.gen.yaml"


class ConfigTest(unittest.TestCase):
    def template(self, config):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "buf.gen.yaml"
            path.write_text(yaml.safe_dump(config), encoding="utf-8")
            return typescript_template(path, Path("/pinned/protoc-gen-es"), Path("/output/ts"))

    def test_real_config_options_and_import_setting_are_preserved(self):
        config = yaml.safe_load(CONFIG.read_text())
        template = self.template(config)
        self.assertEqual(template["plugins"][0]["opt"], config["plugins"][0]["opt"])
        self.assertEqual(template["plugins"][0]["include_imports"], config["plugins"][0]["include_imports"])

    def test_changed_options_are_forwarded_without_old_defaults(self):
        config = yaml.safe_load(CONFIG.read_text())
        config["plugins"][0]["opt"] = ["target=js", "import_extension=js", "erasable_syntax=false"]
        config["plugins"][0]["include_imports"] = False
        plugin = self.template(config)["plugins"][0]
        self.assertEqual(plugin["opt"], config["plugins"][0]["opt"])
        self.assertFalse(plugin["include_imports"])

    def test_another_plugin_cannot_silently_use_the_old_binary(self):
        config = yaml.safe_load(CONFIG.read_text())
        config["plugins"][0]["local"] = ["another-plugin"]
        with self.assertRaisesRegex(ValueError, "pinned local"):
            self.template(config)

    def test_an_added_plugin_requires_explicit_bazel_output_support(self):
        config = yaml.safe_load(CONFIG.read_text())
        config["plugins"].append(config["plugins"][0].copy())
        with self.assertRaisesRegex(ValueError, "single-plugin"):
            self.template(config)


class GenerationTest(unittest.TestCase):
    def test_protobuf_only_output_does_not_attempt_wire_generation(self):
        image = {
            "file": [
                {
                    "name": "google/api/client.proto",
                    "package": "google.api",
                    "syntax": "proto3",
                    "messageType": [{"name": "PythonSettings", "nestedType": [{"name": "ExperimentalFeatures"}]}],
                }
            ]
        }

        def generate(command, **_kwargs):
            template = json.loads(command[command.index("--template") + 1])
            output = Path(template["plugins"][0]["out"]) / "google/api/client_pb.ts"
            output.parent.mkdir(parents=True)
            output.write_text("// synthetic protobuf output\n")

        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "client_pb.ts"
            args = [
                "codegen",
                "--format",
                "ts",
                "--package",
                "google.api",
                "--buf",
                "/pinned/buf",
                "--plugin",
                "/pinned/plugin",
                "--config",
                str(CONFIG),
                "--output",
                f"google/api/client_pb.ts={target}",
            ]
            with (
                patch.object(sys, "argv", args),
                patch("bazel_codegen.subprocess.check_output", return_value=json.dumps(image).encode()),
                patch("bazel_codegen.subprocess.run", side_effect=generate),
            ):
                main()
            self.assertEqual(target.read_text(), "// synthetic protobuf output\n")

    def test_explicit_schema_target_uses_the_declared_output_path(self):
        image = {
            "file": [
                {
                    "name": "selected/v1/item.proto",
                    "package": "selected.v1",
                    "syntax": "proto3",
                    "messageType": [{"name": "Item", "field": []}],
                }
            ]
        }
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "item.schema.json"
            args = [
                "codegen",
                "--format",
                "schema",
                "--package",
                "selected.v1",
                "--buf",
                "/pinned/buf",
                "--schema-identity",
                "https://schema.local/item",
                "--schema-title",
                "Selected",
                "--output",
                f"selected.schema.json={target}",
            ]
            with (
                patch.object(sys, "argv", args),
                patch("bazel_codegen.subprocess.check_output", return_value=json.dumps(image).encode()),
            ):
                main()
            schema = json.loads(target.read_text())
            self.assertEqual(schema["$id"], "https://schema.local/item")
            self.assertIn("Item", schema["$defs"])


if __name__ == "__main__":
    unittest.main()
