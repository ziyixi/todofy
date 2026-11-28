"""One-shot ModelBundle & MlRun publisher for headless Colab and local runners (KISS)."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import tarfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pyarrow as pa

from .client import DatasetError, _NoRedirect
from .constants import __version__

MAX_PUBLISH_BYTES = 28 * 1024 * 1024


def _coerce_bytes(item: bytes | str | Path) -> bytes:
    if isinstance(item, bytes):
        return item
    if isinstance(item, Path):
        return item.read_bytes()
    if isinstance(item, str):
        return item.encode("utf-8")
    raise TypeError(f"Unsupported artifact payload type: {type(item)!r}")


def build_model_bundle_archive(
    *,
    node: Mapping[str, Any],
    run: Mapping[str, Any],
    forum_post: Mapping[str, Any] | None = None,
    charts: Mapping[str, bytes | str | Path] | None = None,
    bundle_files: Mapping[str, bytes | str | Path] | None = None,
) -> tuple[bytes, str]:
    """Pack deterministic Zstd-compressed ``bundle.tar.zst`` in memory and return ``(bytes, sha256)``."""
    tar_buf = io.BytesIO()
    manifest_payload = {
        "schema_version": 1,
        "sdk_version": __version__,
        "node": dict(node),
        "run": dict(run),
        "forum_post": dict(forum_post) if forum_post is not None else None,
        "charts": sorted((charts or {}).keys()),
        "bundle_files": sorted((bundle_files or {}).keys()),
    }
    entries: list[tuple[str, bytes]] = [
        (
            "run_manifest.json",
            (
                json.dumps(manifest_payload, separators=(",", ":"), sort_keys=True)
                + "\n"
            ).encode("utf-8"),
        )
    ]
    for name, raw in sorted((charts or {}).items()):
        clean_name = Path(name).name
        entries.append((f"charts/{clean_name}", _coerce_bytes(raw)))
    for name, raw in sorted((bundle_files or {}).items()):
        clean_name = str(name).lstrip("/")
        entries.append((f"artifacts/{clean_name}", _coerce_bytes(raw)))

    with tarfile.open(fileobj=tar_buf, mode="w") as tf:
        for arcname, payload in entries:
            info = tarfile.TarInfo(name=arcname)
            info.size = len(payload)
            info.mtime = 0
            info.mode = 0o644
            tf.addfile(info, io.BytesIO(payload))

    raw_tar = tar_buf.getvalue()
    out_sink = pa.BufferOutputStream()
    with pa.CompressedOutputStream(out_sink, "zstd") as zst_out:
        zst_out.write(raw_tar)
    comp_bytes = out_sink.getvalue().to_pybytes()
    sha = hashlib.sha256(comp_bytes).hexdigest()
    return comp_bytes, sha


def unpack_model_bundle_archive(comp_bytes: bytes) -> bytes:
    """Decompress a standard Zstd-framed ``bundle.tar.zst`` archive into raw tar bytes."""
    with pa.CompressedInputStream(pa.BufferReader(comp_bytes), "zstd") as zst_in:
        return bytes(zst_in.readall())


def publish_ml_run(
    *,
    base_url: str,
    write_key: str,
    node: Mapping[str, Any],
    run: Mapping[str, Any],
    forum_post: Mapping[str, Any] | None = None,
    charts: Mapping[str, bytes | str | Path] | None = None,
    bundle_files: Mapping[str, bytes | str | Path] | None = None,
    endpoint_path: str = "api/quant/ml/v1/runs:publish",
    max_bytes: int = MAX_PUBLISH_BYTES,
    timeout: float = 120.0,
) -> dict[str, Any]:
    """Upload one complete MlRun + Lineage Node + optional Forum Post & ModelBundle in a single request."""
    if (
        not isinstance(write_key, str)
        or not write_key.strip()
        or any(ch.isspace() for ch in write_key)
    ):
        raise DatasetError("KEY_MISSING", "QUANT_ML_WRITE_KEY 不能为空或包含空白字符。")
    if not str(run.get("score_formula") or "").strip():
        raise ValueError(
            "score_formula is required in run metadata for explicit provenance"
        )

    parts = urllib.parse.urlsplit(base_url)
    loopback = parts.scheme == "http" and parts.hostname in {
        "127.0.0.1",
        "localhost",
        "::1",
    }
    if not parts.hostname or not (parts.scheme == "https" or loopback):
        raise DatasetError(
            "BASE_URL_INVALID", "publish_ml_run 需要 HTTPS 入口或本机回环地址。"
        )

    archive_bytes, archive_sha = build_model_bundle_archive(
        node=node,
        run=run,
        forum_post=forum_post,
        charts=charts,
        bundle_files=bundle_files,
    )
    chart_items: list[dict[str, str]] = []
    for name, raw in sorted((charts or {}).items()):
        b_raw = _coerce_bytes(raw)
        ext = Path(name).suffix.lower()
        ctype = (
            "image/svg+xml"
            if ext == ".svg"
            else ("text/html" if ext in {".html", ".htm"} else "image/png")
        )
        chart_items.append(
            {
                "name": Path(name).name,
                "content_type": ctype,
                "sha256": hashlib.sha256(b_raw).hexdigest(),
                "data_b64": base64.b64encode(b_raw).decode("ascii"),
            }
        )

    node_payload = dict(node)
    node_payload.setdefault("bundle_sha256", archive_sha)
    body_obj: dict[str, Any] = {
        "node": node_payload,
        "run": dict(run),
        "charts": chart_items,
        "bundle_sha256": archive_sha,
        "bundle_zst_b64": base64.b64encode(archive_bytes).decode("ascii"),
    }
    if forum_post is not None:
        body_obj["forum_post"] = dict(forum_post)

    encoded = json.dumps(body_obj, separators=(",", ":")).encode("utf-8")
    if len(encoded) > int(max_bytes):
        raise DatasetError(
            "BAD_REQUEST",
            f"单次上传包体积 {len(encoded):,} 字节超过上限 {max_bytes:,} 字节（28 MiB）。",
        )

    url = f"{base_url.rstrip('/')}/{endpoint_path.lstrip('/')}"
    req = urllib.request.Request(
        url,
        data=encoded,
        method="POST",
        headers={
            "Authorization": f"Bearer {write_key}",
            "Content-Type": "application/json",
            "User-Agent": f"Todofy-Research-Datasets/{__version__}",
            "X-Bundle-Sha256": archive_sha,
        },
    )
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw_resp = resp.read()
            if resp.status not in (200, 201):
                raise DatasetError(
                    "UNEXPECTED_STATUS", f"HTTP {resp.status}", resp.status
                )
            return json.loads(raw_resp.decode("utf-8")) if raw_resp else {"ok": True}
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = err.read().decode("utf-8", errors="replace")[:300]
        except OSError:
            pass
        raise DatasetError("HTTP", f"HTTP {err.code}: {detail}", err.code) from None
