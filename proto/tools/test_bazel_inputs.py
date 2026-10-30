"""The Bazel adapter preserves authoritative generator options and rejects unsupported plugin changes."""

from pathlib import Path
import tempfile
import unittest

import yaml

from bazel_codegen import typescript_template

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


if __name__ == "__main__":
    unittest.main()
