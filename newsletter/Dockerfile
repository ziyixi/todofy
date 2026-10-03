FROM ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 AS uv
FROM python:3.12.14-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254 AS base

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

FROM base AS builder
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1
WORKDIR /opt/newsletter
COPY pyproject.toml uv.lock .python-version MANIFEST.in ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --extra codex --no-install-project
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --extra codex --no-editable

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
RUN mkdir -p /var/lib/newsletter /var/lib/newsletter-auth \
    && chown newsletter:newsletter /var/lib/newsletter /var/lib/newsletter-auth
USER newsletter
ENV PATH="/opt/newsletter/.venv/bin:$PATH" \
    NEWSLETTER_DATA_DIR=/var/lib/newsletter \
    NEWSLETTER_CHART_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
EXPOSE 8080
# Long startup probes are intentional; liveness is exposed only after preflight.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3)"
ENTRYPOINT ["newsletter"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8080"]
