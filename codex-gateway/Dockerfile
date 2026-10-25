# Build from the repository root after proto/tools/ensure.mjs generated Python.
FROM ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 AS uv
FROM python:3.14.7-slim-bookworm@sha256:82bc3c539b8813ada9d68c63b40158fa002f7f33de9bf3312a3dfdc0620dff56 AS base

FROM base AS builder
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/codex-gateway/.venv
WORKDIR /opt/workspace
COPY pyproject.toml uv.lock .python-version ./
COPY newsletter/pyproject.toml ./newsletter/pyproject.toml
COPY codex-gateway/pyproject.toml ./codex-gateway/pyproject.toml
COPY platform/pyproject.toml ./platform/pyproject.toml
COPY todofy/pyproject.toml ./todofy/pyproject.toml
COPY proto/python/pyproject.toml ./proto/python/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --package personal-codex-gateway --no-dev --no-install-workspace

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
