FROM python:3.14.7-slim@sha256:51dafde81dbdb6ebde285137a295cf18a47ca95234fe388a343719cb97305b3d

RUN apt-get update \
    && apt-get install -y --no-install-recommends gnupg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chmod=0444 mailhero_backup.py container.py /app/

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp BACKUP_AT_UTC=04:17
USER 1000:1000
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD ["python3", "-I", "/app/container.py", "health"]
ENTRYPOINT ["python3", "-I", "/app/container.py"]
CMD ["run"]
