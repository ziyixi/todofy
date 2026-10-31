UV ?= uv
BAZEL ?= bazel
RUN := $(UV) run --locked --package personal-newsletter
SOURCE_SHA ?= $(shell git rev-parse HEAD)

.PHONY: setup lock-check test lint format typecheck check build smoke smoke-codex demo serve proto-check

setup:
	$(UV) sync --locked --package personal-newsletter

lock-check:
	$(BAZEL) test //newsletter/tests:test_tooling

test:
	$(BAZEL) test //newsletter:tests

lint:
	$(BAZEL) test //newsletter:ruff_check_test //newsletter:ruff_format_test //newsletter:python_structure_test

format:
	$(BAZEL) run //newsletter:format

typecheck:
	$(BAZEL) test //newsletter:mypy_test

check:
	$(BAZEL) test //newsletter:check

build:
	$(BAZEL) build //newsletter --platforms=//tools/bazel/images:linux_amd64 --embed_label=$(SOURCE_SHA)

smoke:
	$(BAZEL) test //newsletter:smoke_http_test

smoke-codex:
	$(BAZEL) test //newsletter:smoke_codex_startup_test

demo:
	$(RUN) newsletter demo

serve:
	$(RUN) newsletter serve

proto-check:
	$(BAZEL) test //newsletter:wheel_smoke_test
