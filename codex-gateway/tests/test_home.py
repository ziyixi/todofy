"""Real synthetic files only; no login data, runtime process or model call."""

import contextlib
import os
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from codex_gateway import __main__ as server


class PrivateCliHome(unittest.TestCase):
    def test_cli_state_is_private_and_auth_writes_reach_the_original_file(self):
        with tempfile.TemporaryDirectory() as directory:
            shared = pathlib.Path(directory) / "login"
            shared.mkdir()
            auth = shared / "auth.json"
            auth.write_text("synthetic login")
            auth.chmod(0o600)
            inode = auth.stat().st_ino
            cache = shared / "models_cache.json"
            cache.write_text("newsletter cache")
            skill = shared / "skills" / ".system" / "newsletter-skill" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text("newsletter skill")
            homes = []
            app = object()
            data_dir = pathlib.Path(directory) / "persistent-monitor"

            def run(actual_app, **options):
                self.assertIs(actual_app, app)
                self.assertFalse(options["access_log"])
                home = pathlib.Path(os.environ["CODEX_HOME"])
                homes.append(home)
                self.assertNotEqual(home, shared)
                self.assertTrue((home / "auth.json").is_symlink())
                self.assertTrue(os.path.samefile(home / "auth.json", auth))
                (home / "models_cache.json").write_text("gateway cache")
                private_skill = (
                    home / "skills" / ".system" / "gateway-skill" / "SKILL.md"
                )
                private_skill.parent.mkdir(parents=True)
                private_skill.write_text("gateway skill")
                with (
                    contextlib.closing(
                        sqlite3.connect(home / "state.sqlite")
                    ) as database,
                    database,
                ):
                    database.execute("CREATE TABLE synthetic (id INTEGER)")
                # The pinned file store opens with truncate/write, preserving the inode.
                with (home / "auth.json").open("w") as target:
                    target.write("synthetic refreshed login")
                self.assertEqual(auth.stat().st_ino, inode)
                self.assertFalse((shared / "state.sqlite").exists())

            with (
                patch.dict(
                    os.environ,
                    {"CODEX_HOME": str(shared), "DATA_DIR": str(data_dir)},
                ),
                patch.object(server, "create_app", return_value=app) as create_app,
                patch.object(server.uvicorn, "run", side_effect=run),
            ):
                server.main()
                create_app.assert_called_once_with(
                    monitor_db=data_dir / "inference-monitor.sqlite3"
                )
                self.assertEqual(os.environ["CODEX_HOME"], str(shared))
            self.assertEqual(len(homes), 1)
            self.assertFalse(homes[0].exists())
            self.assertEqual(auth.read_text(), "synthetic refreshed login")
            self.assertEqual(cache.read_text(), "newsletter cache")
            self.assertEqual(skill.read_text(), "newsletter skill")
            self.assertEqual(set(shared.iterdir()), {auth, cache, shared / "skills"})

    def test_server_failure_cleans_private_home_and_retains_shared_login(self):
        with tempfile.TemporaryDirectory() as directory:
            shared = pathlib.Path(directory)
            auth = shared / "auth.json"
            auth.write_text("synthetic login")
            homes = []

            def run(*args, **options):
                homes.append(pathlib.Path(os.environ["CODEX_HOME"]))
                raise RuntimeError("synthetic server failure")

            with (
                patch.dict(os.environ, {"CODEX_HOME": str(shared)}, clear=True),
                patch.object(server, "create_app", return_value=object()) as create_app,
                patch.object(server.uvicorn, "run", side_effect=run),
                self.assertRaisesRegex(RuntimeError, "synthetic server failure"),
            ):
                server.main()
            create_app.assert_called_once_with(
                monitor_db=pathlib.Path(".data/inference-monitor.sqlite3")
            )
            self.assertEqual(len(homes), 1)
            self.assertFalse(homes[0].exists())
            self.assertEqual(auth.read_text(), "synthetic login")
            self.assertEqual(set(shared.iterdir()), {auth})
