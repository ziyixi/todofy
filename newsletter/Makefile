UV ?= uv
RUN := $(UV) run --locked --package personal-newsletter --extra codex
ARTIFACT_DIR ?= .artifacts

.PHONY: setup lock-check test lint format typecheck check build smoke smoke-codex demo serve proto-check

setup:
	$(UV) sync --locked --package personal-newsletter --extra codex

lock-check:
	$(UV) lock --check

test:
	$(RUN) pytest -q

lint:
	$(RUN) ruff check src tests scripts
	$(RUN) ruff format --check src tests scripts
	$(RUN) python scripts/check_python_structure.py

format:
	$(RUN) ruff format src tests scripts

typecheck:
	$(RUN) mypy

check: lock-check lint typecheck test

build: lock-check
	$(UV) build --package personal-newsletter --out-dir $(ARTIFACT_DIR)/dist

smoke:
	$(RUN) python scripts/smoke_http.py

smoke-codex:
	$(RUN) python scripts/smoke_codex_startup.py

demo:
	$(RUN) newsletter demo

serve:
	$(RUN) newsletter serve

# Consumer integrity check; generation belongs to the public protos repository.
proto-check:
	$(RUN) python -c 'from newsletter.preflight import check_proto_dependency; check_proto_dependency()'
