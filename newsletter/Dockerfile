FROM ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 AS uv
FROM python:3.14.7-slim-bookworm@sha256:82bc3c539b8813ada9d68c63b40158fa002f7f33de9bf3312a3dfdc0620dff56 AS base

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

FROM base AS builder
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/newsletter/.venv
WORKDIR /opt/workspace
COPY pyproject.toml uv.lock .python-version ./
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY newsletter/pyproject.toml ./newsletter/pyproject.toml
COPY codex-gateway/pyproject.toml ./codex-gateway/pyproject.toml
COPY platform/pyproject.toml ./platform/pyproject.toml
COPY todofy/pyproject.toml ./todofy/pyproject.toml
COPY proto/python/pyproject.toml ./proto/python/pyproject.toml
COPY packages/model-router-client/python/pyproject.toml ./packages/model-router-client/python/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --package personal-newsletter --no-dev --no-install-workspace
COPY proto ./proto
COPY packages/model-router-client/python/src ./packages/model-router-client/python/src
COPY newsletter/MANIFEST.in ./newsletter/MANIFEST.in
COPY newsletter/src ./newsletter/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --package personal-newsletter --no-dev --no-editable

FROM base AS runtime
ARG BUILD_SHA=""
ARG SOURCE_REPOSITORY="https://github.com/ziyixi/todofy"
LABEL org.opencontainers.image.source=$SOURCE_REPOSITORY
LABEL org.opencontainers.image.revision=$BUILD_SHA
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fonts-noto-cjk tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 newsletter
WORKDIR /opt/newsletter
RUN python -c 'import json, os; from pathlib import Path; Path("build-info.json").write_text(json.dumps({"source_sha": os.environ.get("BUILD_SHA", "")}))'
COPY --from=builder /opt/newsletter/.venv /opt/newsletter/.venv
# The owner console's public Access policy: the team's issuer and the console application's AUD, as codex-gateway
# bakes its own. No file until config/resources.toml records that AUD; the console then answers NOT_CONFIGURED.
COPY config/cloud.toml config/resources.toml ./public-build-config/
RUN /opt/newsletter/.venv/bin/python -I -c 'import pathlib, newsletter.console_access as access; access.write_policy(pathlib.Path("public-build-config"), access.POLICY_FILE)'
RUN mkdir -p /var/lib/newsletter \
    && chown newsletter:newsletter /var/lib/newsletter
USER newsletter
ENV PATH="/opt/newsletter/.venv/bin:$PATH" \
    NEWSLETTER_DATA_DIR=/var/lib/newsletter \
    NEWSLETTER_CHART_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
EXPOSE 8080 8081
# Long startup probes are intentional; liveness is exposed only after preflight.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3)"
ENTRYPOINT ["newsletter"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8080"]
