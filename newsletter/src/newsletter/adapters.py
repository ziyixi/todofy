"""Explicit provider boundaries; fakes never open a network connection.

Every real write has one attempt only. The worker owns durable dispatch state;
an ambiguous outcome must never cause it to call an adapter again. A provider
acceptance is not evidence of inbox delivery. Real Notion synchronization
lives in notion_sync/notion_api; the packet projection here is only the
offline fixture (FakeNotion) or the disabled policy.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
from collections.abc import Mapping
import email.message as email_message
import email.policy as policy
import email.utils as utils
import hashlib
import hmac
import os
import pathlib
import re
import tempfile
from typing import Any, cast, Protocol

import google.protobuf.message as google_protobuf_message
import httpx

import newsletter.contracts as contracts
import newsletter.types as types

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_CID = "newsletter-chart"
_MAX_FROZEN_BYTES = 8 * 1024 * 1024
_PROVIDER_ID = re.compile(r"[A-Za-z0-9_.:-]{1,200}\Z")


class AdapterError(RuntimeError):
    """Expose safe codes, never tokens, response bodies or email content."""

    def __init__(self, code: str, ambiguous: bool = False) -> None:
        self.code = code
        self.ambiguous = ambiguous
        super().__init__(code)


class NotionAdapter(Protocol):
    """Project a public packet without owning durable dispatch state."""

    async def project(
        self, packet: Mapping[str, Any] | google_protobuf_message.Message
    ) -> None:
        """Project one packet or report a safe provider outcome."""
        ...


class MailAdapter(Protocol):
    """Submit an approved frozen edition using a caller-owned request key."""

    async def send(
        self,
        edition: Mapping[str, Any] | google_protobuf_message.Message,
        idempotency_key: str,
    ) -> types.DeliveryResult:
        """Submit a frozen edition once, preserving an ambiguous outcome."""
        ...


def _mapping(
    value: Mapping[str, Any] | google_protobuf_message.Message,
) -> types.Payload:
    if isinstance(value, google_protobuf_message.Message):
        return contracts.to_dict(value)
    if not isinstance(value, Mapping):
        raise AdapterError("INVALID_ADAPTER_INPUT")
    return dict(value)


def _header(
    value: object, code: str, maximum: int = 256, *, ascii_only: bool = False
) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise AdapterError(code)
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise AdapterError(code)
    if ascii_only and not value.isascii():
        raise AdapterError(code)
    return value


def _mailbox(value: str) -> str:
    _header(value, "INVALID_MAIL_CONFIGURATION", 320)
    try:
        addresses = utils.getaddresses([value], strict=True)
    except (ValueError, TypeError):
        raise AdapterError("INVALID_MAIL_CONFIGURATION") from None
    if len(addresses) != 1 or not re.fullmatch(
        r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", addresses[0][1]
    ):
        raise AdapterError("INVALID_MAIL_CONFIGURATION")
    return value


def _frozen(edition: Mapping[str, Any]) -> tuple[str, str, str, bytes]:
    """Check the exact saved render without editing or rerendering it."""
    try:
        subject = _header(
            edition["draft"]["subject"], "INVALID_FROZEN_EDITION", 200
        )
        rendered = edition["rendered"]
        html, text = rendered["html"], rendered["text"]
        if (
            not isinstance(html, str)
            or not html
            or not isinstance(text, str)
            or not text
        ):
            raise ValueError
        encoded = rendered.get("chart_png", "")
        png = (
            encoded
            if isinstance(encoded, bytes)
            else base64.b64decode(encoded, validate=True)
        )
        if png and not png.startswith(_PNG_SIGNATURE):
            raise ValueError
        if (
            len(html.encode("utf-8")) + len(text.encode("utf-8")) + len(png)
            > _MAX_FROZEN_BYTES
        ):
            raise ValueError
        expected = contracts.content_hash(
            {
                "html": html,
                "text": text,
                "chart_png": base64.b64encode(png).decode("ascii"),
            }
        )
        if not hmac.compare_digest(expected, rendered["render_hash"]):
            raise ValueError
        has_chart = any(
            f"src={quote}cid:{_CID}{quote}" in html for quote in ('"', "'")
        )
        if has_chart != bool(png):
            raise ValueError
        return subject, html, text, png
    except (KeyError, TypeError, ValueError, binascii.Error):
        raise AdapterError("INVALID_FROZEN_EDITION") from None


def _write_once(directory: pathlib.Path, filename: str, data: bytes) -> None:
    """Publish a complete fake artifact atomically without overwriting."""
    temporary = None
    try:
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / filename
        with tempfile.NamedTemporaryFile(
            dir=directory, prefix=".pending-", delete=False
        ) as stream:
            temporary = pathlib.Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, target)
        except FileExistsError:
            if target.read_bytes() != data:
                raise AdapterError("FAKE_IDEMPOTENCY_CONFLICT") from None
    except OSError:
        raise AdapterError("FAKE_STORAGE_ERROR") from None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class DisabledNotion:
    """Implement the explicitly disabled Notion projection policy."""

    async def project(
        self, packet: Mapping[str, Any] | google_protobuf_message.Message
    ) -> None:
        """Leave the packet unprojected without contacting a provider."""
        return


class FakeNotion:
    """Write deterministic local projection artifacts without a network."""

    def __init__(self, directory: pathlib.Path) -> None:
        self.directory = pathlib.Path(directory)

    async def project(
        self, packet: Mapping[str, Any] | google_protobuf_message.Message
    ) -> None:
        """Persist one packet projection using an idempotent local write."""
        packet = _mapping(packet)
        identifier = _header(packet.get("id"), "INVALID_ADAPTER_INPUT", 128)
        contracts.validate_packet_body(packet.get("content", {}))
        filename = hashlib.sha256(identifier.encode()).hexdigest() + ".json"
        data = contracts.canonical_json(
            {"simulated": True, "packet": packet}
        ).encode("utf-8")
        await asyncio.to_thread(_write_once, self.directory, filename, data)


class FakeMail:
    """Write reproducible local MIME messages without sending email."""

    def __init__(self, directory: pathlib.Path) -> None:
        self.directory = pathlib.Path(directory)

    async def send(
        self,
        edition: Mapping[str, Any] | google_protobuf_message.Message,
        idempotency_key: str,
    ) -> types.DeliveryResult:
        """Write an idempotent local MIME preview of the exact frozen render."""
        edition = _mapping(edition)
        _header(idempotency_key, "INVALID_IDEMPOTENCY_KEY", ascii_only=True)
        subject, html, text, png = _frozen(edition)
        digest = hashlib.sha256(idempotency_key.encode()).hexdigest()
        message = email_message.EmailMessage(policy=policy.SMTP)
        message["From"] = "Newsletter Preview <preview@example.invalid>"
        message["To"] = "reader@example.invalid"
        message["Subject"] = subject
        message["Message-ID"] = f"<simulated-{digest}@example.invalid>"
        message["X-Newsletter-Simulated"] = "true"
        message["X-Newsletter-Edition"] = _header(
            edition.get("id"), "INVALID_FROZEN_EDITION", 128
        )
        message["X-Newsletter-Render-Hash"] = edition["rendered"]["render_hash"]
        message.set_content(text)
        message.add_alternative(html, subtype="html")
        message.set_boundary(f"newsletter-alt-{digest}")
        if png:
            # add_alternative establishes a multipart of EmailMessage children.
            html_part = cast(
                list[email_message.EmailMessage], message.get_payload()
            )[1]
            html_part.add_related(
                png,
                maintype="image",
                subtype="png",
                cid=f"<{_CID}>",
                filename="newsletter-chart.png",
            )
            html_part.set_boundary(f"newsletter-related-{digest}")
        await asyncio.to_thread(
            _write_once, self.directory, digest + ".eml", message.as_bytes()
        )
        return {
            "delivery_state": "simulated",
            "provider_message_id": f"simulated-{digest}",
        }


async def _post(
    url: str,
    headers: dict[str, str],
    payload: types.Payload,
    transport: httpx.AsyncBaseTransport | None,
    provider: str,
) -> types.Payload:
    """One fixed-endpoint POST; redirects and automatic retries are disabled."""
    try:
        async with httpx.AsyncClient(
            transport=transport,
            timeout=30,
            follow_redirects=False,
            trust_env=False,
        ) as client:
            response = await client.post(url, headers=headers, json=payload)
    except httpx.RequestError:
        raise AdapterError(f"{provider}_UNKNOWN", ambiguous=True) from None
    # A 409 may mean the same idempotent request is already being processed.
    if 400 <= response.status_code < 500 and response.status_code not in {
        408,
        409,
        429,
    }:
        raise AdapterError(f"{provider}_REJECTED")
    if not 200 <= response.status_code < 300:
        raise AdapterError(f"{provider}_UNKNOWN", ambiguous=True)
    try:
        result = response.json()
        if not isinstance(result, dict) or not isinstance(
            result.get("id"), str
        ):
            raise ValueError
        if not _PROVIDER_ID.fullmatch(result["id"]):
            raise ValueError
        return result
    except (ValueError, UnicodeError):
        raise AdapterError(f"{provider}_UNKNOWN", ambiguous=True) from None


class Resend:
    """Submit non-fixture frozen editions to the configured mail account."""

    def __init__(
        self,
        key: str,
        from_email: str,
        recipient_email: str,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._key = _header(
            key, "INVALID_MAIL_CONFIGURATION", 512, ascii_only=True
        )
        self._from = _mailbox(from_email)
        self._recipient = _mailbox(recipient_email)
        self._transport = transport

    async def send(
        self,
        edition: Mapping[str, Any] | google_protobuf_message.Message,
        idempotency_key: str,
    ) -> types.DeliveryResult:
        """Submit the exact frozen render using the supplied request key."""
        edition = _mapping(edition)
        if edition.get("is_fixture") is not False:
            raise AdapterError("FIXTURE_SEND_FORBIDDEN")
        _header(idempotency_key, "INVALID_IDEMPOTENCY_KEY", ascii_only=True)
        subject, html, text, png = _frozen(edition)
        payload: types.Payload = {
            "from": self._from,
            "to": [self._recipient],
            "subject": subject,
            "html": html,
            "text": text,
        }
        if png:
            payload["attachments"] = [
                {
                    "filename": "newsletter-chart.png",
                    "content_type": "image/png",
                    "content": base64.b64encode(png).decode("ascii"),
                    "content_id": _CID,
                }
            ]
        result = await _post(
            "https://api.resend.com/emails",
            {
                "Authorization": f"Bearer {self._key}",
                "Idempotency-Key": idempotency_key,
            },
            payload,
            self._transport,
            "MAIL",
        )
        return {
            "delivery_state": "provider_accepted",
            "provider_message_id": result["id"],
        }
