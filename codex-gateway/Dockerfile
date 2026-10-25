# Build from the repository root after proto/tools/ensure.mjs generated Python.
FROM ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 AS uv
FROM python:3.12.14-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254 AS base

FROM base AS builder
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1
WORKDIR /opt/codex-gateway
COPY codex-gateway/pyproject.toml codex-gateway/uv.lock ./
COPY proto/python/pyproject.toml /opt/proto/python/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project --no-install-package ziyixi-proto

FROM base AS runtime
ARG SOURCE_SHA
ARG SOURCE_REPOSITORY="https://github.com/ziyixi/todofy"
LABEL org.opencontainers.image.source=$SOURCE_REPOSITORY
LABEL org.opencontainers.image.revision=$SOURCE_SHA
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    PATH=/opt/codex-gateway/.venv/bin:$PATH \
    PYTHONPATH=/opt/codex-gateway/app
RUN useradd --create-home --uid 10001 codex-gateway
WORKDIR /opt/codex-gateway
COPY --from=builder /opt/codex-gateway/.venv ./.venv
COPY codex-gateway/src ./app
COPY proto/python/src/ziyixi_proto ./app/ziyixi_proto
RUN python -c 'import json, re, sys; from pathlib import Path; sha = sys.argv[1]; assert re.fullmatch("[a-f0-9]{40}", sha), "SOURCE_SHA must be a full commit SHA"; Path("app/codex_gateway/build-info.json").write_text(json.dumps({"source_sha": sha}))' "$SOURCE_SHA"
USER 10001:10001
ENV HOME=/home/codex-gateway
EXPOSE 8080
ENTRYPOINT ["python", "-m", "codex_gateway"]
