# recall's reference archive consumer (README.md): its one standard-library file on a pinned Python base. Nothing is
# installed on top (no compiler, no build stage); it opens no port and runs as uid 10001. Built, tested and published
# by .github/workflows/recall-sync-image.yml, and pulled by digest.
FROM python:3.12.14-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254

COPY --chmod=0444 recall_sync.py /app/recall_sync.py

WORKDIR /app
USER 10001:10001
# -I: isolated (no PYTHON* variables, nothing imported from the script's folder); -B: no bytecode files. The archive
# is the share mounted at /archive (RECALL_ARCHIVE_DIR); the health check reads only its state.json.
HEALTHCHECK --interval=5m --timeout=10s --start-period=10m \
    CMD ["python3", "-I", "-B", "/app/recall_sync.py", "--check"]
ENTRYPOINT ["python3", "-I", "-B", "/app/recall_sync.py"]
