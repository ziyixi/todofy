# Application code and locked Python dependencies stay inside the OCI image.
FROM ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 AS uv
FROM python:3.12.14-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254 AS base

FROM base AS builder
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1
WORKDIR /opt/personal-cloud/platform
COPY platform/pyproject.toml platform/uv.lock ./
COPY proto/python/pyproject.toml /opt/personal-cloud/proto/python/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project --no-install-package ziyixi-proto

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
