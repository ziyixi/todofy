"""Explicit configuration without implicit legacy .env or model API keys."""

from collections.abc import Callable
import dataclasses
import math
import os
import pathlib
import uuid
import zoneinfo


def _number_env[Number: (int, float)](
    name: str, default: str, parse: Callable[[str], Number]
) -> Number:
    try:
        return parse(os.getenv(name, default))
    except ValueError:
        # Built-in numeric errors echo the input, which may be a misplaced key.
        # Suppress its context even when startup prints a traceback.
        raise ValueError(f"Set a valid numeric value for {name}") from None


def _boolean_env(name: str, default: str = "false") -> bool:
    value = os.getenv(name, default).lower()
    if value not in {"true", "false"}:
        raise ValueError(f"Set true or false for {name}")
    return value == "true"


@dataclasses.dataclass(frozen=True)
class Settings:
    """Explicit service settings with separate private send capabilities.

    Construction keeps programmatic legacy defaults; from_env selects the
    deployed DAG defaults. Call validate before opening service resources.
    """

    data_dir: pathlib.Path = pathlib.Path(".data")
    mode: str = "mock"
    editor_backend: str = "mock"
    editor_token: str = dataclasses.field(default="", repr=False)
    send_token: str = dataclasses.field(default="", repr=False)
    time_zone: str = "America/Los_Angeles"
    job_timeout_seconds: float = 900
    max_body_bytes: int = 1_048_576
    max_packets: int = 20
    max_pending_jobs: int = 8
    notion_backend: str = "disabled"
    notion_token: str = dataclasses.field(default="", repr=False)
    notion_data_source_id: str = ""
    notion_materials_data_source_id: str = ""
    notion_editions_data_source_id: str = ""
    notion_archive_private: bool = False
    mail_backend: str = "fake"
    allow_send: bool = False
    resend_api_key: str = dataclasses.field(default="", repr=False)
    recipient_email: str = ""
    from_email: str = ""
    codex_home: pathlib.Path | None = None
    model: str = "gpt-6-sol"
    todofy_backend: str = "disabled"
    todofy_base_url: str = "https://daily.ziyixi.science"
    todofy_user: str = dataclasses.field(default="", repr=False)
    todofy_password: str = dataclasses.field(default="", repr=False)
    todofy_mode: str = "recommendation"
    todofy_top: int = 5
    instructions_dir: pathlib.Path = (
        pathlib.Path(__file__).parent / "instructions"
    )
    collection_timeout_seconds: float = 600
    # Programmatic legacy adapters remain available for existing callers/tests.
    # CLI/environment deployments default to the versioned DAG.
    workflow_backend: str = "legacy"
    workflow_file: pathlib.Path = (
        pathlib.Path(__file__).parent / "workflows" / "daily.yaml"
    )
    discovery_dir: pathlib.Path = (
        pathlib.Path(__file__).parent / "instructions" / "discovery"
    )
    content_config_dir: pathlib.Path | None = None
    workflow_timeout_seconds: float = 5400

    @classmethod
    def from_env(cls) -> "Settings":
        """Read declared environment variables without loading dotenv files."""
        return cls(
            data_dir=pathlib.Path(os.getenv("NEWSLETTER_DATA_DIR", ".data")),
            mode=os.getenv("NEWSLETTER_MODE", "mock"),
            editor_backend=os.getenv("NEWSLETTER_EDITOR", "mock"),
            editor_token=os.getenv("NEWSLETTER_EDITOR_TOKEN", ""),
            send_token=os.getenv("NEWSLETTER_SEND_TOKEN", ""),
            time_zone=os.getenv("NEWSLETTER_TIME_ZONE", "America/Los_Angeles"),
            job_timeout_seconds=_number_env(
                "NEWSLETTER_JOB_TIMEOUT_SECONDS", "900", float
            ),
            notion_backend=os.getenv("NEWSLETTER_NOTION", "disabled"),
            notion_token=os.getenv("NOTION_TOKEN", ""),
            notion_data_source_id=os.getenv("NOTION_DATA_SOURCE_ID", ""),
            notion_materials_data_source_id=os.getenv(
                "NOTION_MATERIALS_DATA_SOURCE_ID", ""
            ),
            notion_editions_data_source_id=os.getenv(
                "NOTION_EDITIONS_DATA_SOURCE_ID", ""
            ),
            notion_archive_private=_boolean_env(
                "NEWSLETTER_NOTION_ARCHIVE_PRIVATE"
            ),
            mail_backend=os.getenv("NEWSLETTER_MAIL", "fake"),
            allow_send=os.getenv("NEWSLETTER_ALLOW_SEND", "false").lower()
            == "true",
            resend_api_key=os.getenv("RESEND_API_KEY", ""),
            recipient_email=os.getenv("RECIPIENT_EMAIL", ""),
            from_email=os.getenv("NEWSLETTER_FROM_EMAIL", ""),
            codex_home=pathlib.Path(os.environ["NEWSLETTER_CODEX_HOME"])
            if os.getenv("NEWSLETTER_CODEX_HOME")
            else None,
            model=os.getenv("NEWSLETTER_MODEL", "gpt-6-sol"),
            todofy_backend=os.getenv("NEWSLETTER_TODOFY", "disabled"),
            todofy_base_url=os.getenv(
                "TODO_API_BASE", "https://daily.ziyixi.science"
            ),
            todofy_user=os.getenv("TODO_API_USER", ""),
            todofy_password=os.getenv("TODO_API_PASSWORD", ""),
            todofy_mode=os.getenv("NEWSLETTER_TODOFY_MODE", "recommendation"),
            todofy_top=_number_env("NEWSLETTER_TODOFY_TOP", "5", int),
            instructions_dir=pathlib.Path(
                os.environ["NEWSLETTER_INSTRUCTIONS_DIR"]
            )
            if os.getenv("NEWSLETTER_INSTRUCTIONS_DIR")
            else pathlib.Path(__file__).parent / "instructions",
            collection_timeout_seconds=_number_env(
                "NEWSLETTER_COLLECTION_TIMEOUT_SECONDS", "600", float
            ),
            workflow_backend=os.getenv("NEWSLETTER_WORKFLOW", "dag"),
            workflow_file=pathlib.Path(os.environ["NEWSLETTER_WORKFLOW_FILE"])
            if os.getenv("NEWSLETTER_WORKFLOW_FILE")
            else pathlib.Path(__file__).parent / "workflows" / "daily.yaml",
            discovery_dir=pathlib.Path(os.environ["NEWSLETTER_DISCOVERY_DIR"])
            if os.getenv("NEWSLETTER_DISCOVERY_DIR")
            else pathlib.Path(__file__).parent / "instructions" / "discovery",
            content_config_dir=pathlib.Path(
                os.environ["NEWSLETTER_CONTENT_CONFIG_DIR"]
            )
            if os.getenv("NEWSLETTER_CONTENT_CONFIG_DIR")
            else None,
            workflow_timeout_seconds=_number_env(
                "NEWSLETTER_WORKFLOW_TIMEOUT_SECONDS", "5400", float
            ),
        )

    @property
    def notion_v2(self) -> bool:
        """Use the dual database adapter only with both destinations set."""
        return bool(
            self.notion_materials_data_source_id
            and self.notion_editions_data_source_id
        )

    def validate(self) -> None:
        """Reject invalid limits, mixed live/mock adapters and unsafe paths."""
        self._validate_workflow()
        self._validate_todofy()
        self._validate_runtime()
        self._validate_notion()
        self._validate_delivery_limits()

    def _validate_workflow(self) -> None:
        if self.workflow_backend not in {"dag", "legacy"}:
            raise ValueError("NEWSLETTER_WORKFLOW must be dag or legacy")
        if self.content_config_dir is not None:
            if self.workflow_backend != "dag":
                raise ValueError(
                    "Content configuration requires NEWSLETTER_WORKFLOW=dag"
                )
            if self.content_config_dir.resolve() in {
                pathlib.Path("/"),
                pathlib.Path.home(),
                self.data_dir.resolve(),
            }:
                raise ValueError(
                    "Content configuration requires a dedicated directory"
                )
        if (
            not math.isfinite(self.workflow_timeout_seconds)
            or not 60 <= self.workflow_timeout_seconds <= 14400
        ):
            raise ValueError(
                "Workflow timeout must be within 60..14400 seconds"
            )
        if (
            not math.isfinite(self.collection_timeout_seconds)
            or not 0 < self.collection_timeout_seconds <= 1800
        ):
            raise ValueError(
                "Collection timeout must be within 0..1800 seconds per "
                "direction"
            )

    def _validate_todofy(self) -> None:
        if self.todofy_backend not in {"disabled", "fake", "todofy"}:
            raise ValueError(
                "NEWSLETTER_TODOFY must be disabled, fake or todofy"
            )
        if (
            self.todofy_mode not in {"recommendation", "summary"}
            or not 1 <= self.todofy_top <= 10
        ):
            raise ValueError("Invalid Todofy mode or item limit")
        if self.todofy_backend == "todofy" and not (
            self.todofy_user and self.todofy_password
        ):
            raise ValueError(
                "Todofy requires TODO_API_USER and TODO_API_PASSWORD"
            )
        if self.mode == "mock" and self.todofy_backend == "todofy":
            raise ValueError("Mock mode forbids real Todofy requests")
        if self.mode == "live" and self.todofy_backend == "fake":
            raise ValueError("Live mode forbids fake personal events")

    def _validate_runtime(self) -> None:
        directory = self.data_dir.resolve()
        if directory in {
            pathlib.Path(directory.anchor),
            pathlib.Path.home().resolve(),
            pathlib.Path.cwd().resolve(),
        }:
            raise ValueError(
                "Use a dedicated child directory for newsletter data"
            )
        if self.data_dir.is_symlink() or (
            directory.exists() and not directory.is_dir()
        ):
            raise ValueError(
                "Newsletter data must be a dedicated real directory"
            )
        if self.mode not in {"mock", "live"}:
            raise ValueError("NEWSLETTER_MODE must be mock or live")
        if self.editor_backend not in {"mock", "codex"}:
            raise ValueError("NEWSLETTER_EDITOR must be mock or codex")
        if self.notion_backend not in {"disabled", "fake", "notion"}:
            raise ValueError(
                "NEWSLETTER_NOTION must be disabled, fake or notion"
            )
        if self.mail_backend not in {"fake", "resend"}:
            raise ValueError("NEWSLETTER_MAIL must be fake or resend")
        tokens = [self.editor_token, self.send_token]
        if (
            any(
                len(t) < 24 or len(t) > 512 or any(c.isspace() for c in t)
                for t in tokens
            )
            or len(set(tokens)) != 2
        ):
            raise ValueError(
                "Configure distinct editor/send tokens (24+ characters)"
            )
        if self.mode == "mock" and (
            self.editor_backend != "mock"
            or self.mail_backend != "fake"
            or self.notion_backend == "notion"
        ):
            raise ValueError(
                "Mock mode forbids real model, Notion, and mail adapters"
            )
        if self.mode == "live" and self.editor_backend != "codex":
            raise ValueError(
                "Live mode requires the Codex editor; no mock fallback"
            )
        if self.editor_backend == "codex" and self.codex_home is None:
            raise ValueError(
                "Set an isolated NEWSLETTER_CODEX_HOME for the server editor"
            )

    def _validate_notion(self) -> None:
        if type(self.notion_archive_private) is not bool:
            raise ValueError(
                "NEWSLETTER_NOTION_ARCHIVE_PRIVATE must be a boolean"
            )
        if bool(self.notion_materials_data_source_id) != bool(
            self.notion_editions_data_source_id
        ):
            raise ValueError(
                "Set both NOTION_MATERIALS_DATA_SOURCE_ID and "
                "NOTION_EDITIONS_DATA_SOURCE_ID"
            )
        if self.notion_v2:
            if self.workflow_backend != "dag":
                raise ValueError(
                    "Dual-database Notion requires NEWSLETTER_WORKFLOW=dag"
                )
            try:
                materials_id = uuid.UUID(self.notion_materials_data_source_id)
                editions_id = uuid.UUID(self.notion_editions_data_source_id)
            except (ValueError, TypeError, AttributeError):
                raise ValueError(
                    "Notion materials and editions require valid data "
                    "source IDs"
                ) from None
            if materials_id == editions_id:
                raise ValueError(
                    "Notion materials and editions require different data "
                    "sources"
                )
        if self.notion_backend == "notion":
            if not self.notion_token:
                raise ValueError("Notion requires NOTION_TOKEN")
            if not self.notion_v2 and not self.notion_data_source_id:
                raise ValueError(
                    "Notion requires both dual database IDs or legacy "
                    "NOTION_DATA_SOURCE_ID"
                )

    def _validate_delivery_limits(self) -> None:
        if self.mail_backend == "resend" and (
            not self.allow_send
            or not self.resend_api_key
            or not self.recipient_email
            or not self.from_email
        ):
            raise ValueError(
                "Resend requires explicit send enablement, key, from and "
                "recipient"
            )
        if (
            not math.isfinite(self.job_timeout_seconds)
            or not 0 < self.job_timeout_seconds <= 3600
        ):
            raise ValueError(
                "Job timeout must be finite and within 0..3600 seconds"
            )
        if (
            not 1 <= self.max_packets <= 32
            or not 1 <= self.max_pending_jobs <= 100
        ):
            raise ValueError("Invalid packet or queue limits")
        if not 1024 <= self.max_body_bytes <= 8 * 1024 * 1024:
            raise ValueError("Invalid request body limit")
        zoneinfo.ZoneInfo(self.time_zone)
