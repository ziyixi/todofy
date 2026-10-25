# Application code and locked Python dependencies stay inside the OCI image.
FROM ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 AS uv
FROM python:3.14.7-slim-bookworm@sha256:82bc3c539b8813ada9d68c63b40158fa002f7f33de9bf3312a3dfdc0620dff56 AS base

FROM base AS builder
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/personal-cloud/platform/.venv
WORKDIR /opt/personal-cloud
COPY pyproject.toml uv.lock .python-version ./
COPY newsletter/pyproject.toml ./newsletter/pyproject.toml
COPY codex-gateway/pyproject.toml ./codex-gateway/pyproject.toml
COPY platform/pyproject.toml ./platform/pyproject.toml
COPY todofy/pyproject.toml ./todofy/pyproject.toml
COPY proto/python/pyproject.toml ./proto/python/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --package todofy-personal-cloud --no-dev --no-install-workspace

FROM base AS runtime
ARG BUILD_SHA
ARG SOURCE_REPOSITORY
LABEL org.opencontainers.image.source=$SOURCE_REPOSITORY
LABEL org.opencontainers.image.revision=$BUILD_SHA
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    PATH=/opt/personal-cloud/platform/.venv/bin:$PATH \
    PYTHONPATH=/opt/personal-cloud/app
WORKDIR /opt/personal-cloud
COPY --from=builder /opt/personal-cloud/platform/.venv ./platform/.venv
COPY app ./app
COPY build-info.json ./
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["python", "-m", "personal_cloud"]
CMD ["status-daemon"]
