"""Shared safe editorial errors; never expose upstream bodies or credentials."""

_ERROR_MESSAGES = {
    "configuration": "Codex editor configuration is invalid; check SDK and "
    "isolated login "
    "setup.",
    "authentication": "The editor requires a managed ChatGPT login in its "
    "dedicated Codex "
    "home.",
    "rate_limit": "Codex usage is unavailable or exhausted; no alternate "
    "model was "
    "called.",
    "timeout": "The editor timed out and its Codex runtime was stopped.",
    "unavailable": "The Codex editor is unavailable; no alternate model "
    "was called.",
    "invalid_output": "The editor returned invalid or unverifiable output; "
    "publication is "
    "blocked.",
    "invalid_input": "The editor received invalid input or an unsafe "
    "workspace.",
}


class EditorError(Exception):
    """Expose stable failure categories, never vendor messages or stderr."""

    def __init__(self, code: str) -> None:
        self.code = code if code in _ERROR_MESSAGES else "unavailable"
        super().__init__(_ERROR_MESSAGES[self.code])
