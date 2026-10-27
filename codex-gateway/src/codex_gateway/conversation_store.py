"""Content-free receipts for temporary execution contexts and confirmed cleanup."""

import json
import pathlib
import shutil
import sqlite3
import tempfile
from contextlib import closing

from ziyixi_proto.modelrouter.inference.v1.inference_pb import Conversation
from ziyixi_proto.wire_json import from_wire, to_wire


class ConversationStore:
    def __init__(self, path: pathlib.Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(mode=0o600, exist_ok=True)
        path.chmod(0o600)
        with closing(self.connect()) as database, database:
            database.execute("""
                CREATE TABLE IF NOT EXISTS model_conversations (
                    name TEXT PRIMARY KEY,
                    receipt TEXT NOT NULL,
                    workspace TEXT NOT NULL DEFAULT '',
                    config_hash TEXT NOT NULL DEFAULT ''
                )
            """)
            rows = database.execute(
                "SELECT name, receipt, workspace FROM model_conversations"
            ).fetchall()
            for name, raw, workspace in rows:
                receipt = json.loads(raw)
                if receipt["state"] == "open":
                    # No SDK context is resumed or replayed after a process restart.
                    receipt["state"] = "lost"
                    if workspace:
                        path = pathlib.Path(workspace)
                        if (
                            path.parent != pathlib.Path(tempfile.gettempdir())
                            or not path.name.startswith("model-router-")
                            or path.is_symlink()
                        ):
                            raise RuntimeError("Invalid temporary workspace receipt")
                        if path.exists():
                            shutil.rmtree(path)
                    database.execute(
                        "UPDATE model_conversations SET receipt = ?, workspace = '' WHERE name = ?",
                        (json.dumps(receipt), name),
                    )

    def connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path, timeout=5)

    def get(self, name: str) -> Conversation | None:
        with closing(self.connect()) as database:
            row = database.execute(
                "SELECT receipt FROM model_conversations WHERE name = ?", (name,)
            ).fetchone()
        return (
            from_wire(Conversation, json.loads(row[0]), strict=True).message
            if row
            else None
        )

    def config_hash(self, name: str) -> str | None:
        with closing(self.connect()) as database:
            row = database.execute(
                "SELECT config_hash FROM model_conversations WHERE name = ?", (name,)
            ).fetchone()
        return row[0] if row else None

    def put(
        self, receipt: Conversation, workspace: str = "", config_hash: str = ""
    ) -> None:
        # Callers supply only model/parameters/web capability, never prompt/schema.
        with closing(self.connect()) as database, database:
            database.execute(
                "INSERT INTO model_conversations VALUES (?, ?, ?, ?) "
                "ON CONFLICT(name) DO UPDATE SET receipt = excluded.receipt, workspace = excluded.workspace",
                (receipt.name, json.dumps(to_wire(receipt)), workspace, config_hash),
            )
