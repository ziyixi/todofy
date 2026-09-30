.DEFAULT_GOAL := help

NODE ?= node
PNPM ?= pnpm
PORT ?= 3000

# Use Node 24 for every child process, including pnpm and Next.js. A Homebrew
# alternative is scoped to this Make invocation; the login shell is unchanged.
LOCAL_NODE_BIN := $(shell \
	if [ "$$("$(NODE)" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" = 24 ]; then \
	  "$(NODE)" -p 'require("node:path").dirname(process.execPath)'; \
	elif command -v brew >/dev/null 2>&1; then \
	  node_prefix=$$(brew --prefix node@24 2>/dev/null); \
	  if [ -x "$$node_prefix/bin/node" ] && \
	     [ "$$("$$node_prefix/bin/node" -p 'process.versions.node.split(".")[0]')" = 24 ]; then \
	    printf '%s' "$$node_prefix/bin"; \
	  fi; \
	fi)

ifneq ($(LOCAL_NODE_BIN),)
export PATH := $(LOCAL_NODE_BIN):$(PATH)
endif

.PHONY: help install sync preview dev check deploy-relay notion-status check-runtime

help:
	@printf '%s\n' \
	  'make install  Install dependencies from the lockfile' \
	  'make sync     Sync Notion using .env.local' \
	  'make preview  Sync Notion, then start the local website' \
	  'make dev      Start the website using the existing snapshot (no sync)' \
	  'make check    Run formatting, lint, type checks, and unit tests' \
	  'make deploy-relay  Deploy the Notion publish button relay and its secrets' \
	  'make notion-status  Refresh Notion feedback from the live website (no deployment)' \
	  'Preview URL: http://localhost:3000 (override with PORT=3001)'

check-runtime:
	@set -eu; \
	version=$$("$(NODE)" --version 2>/dev/null || true); \
	case "$$version" in \
	  v24.*) ;; \
	  *) printf '%s\n' \
	    "This project requires Node 24.x; found $${version:-no Node installation}." \
	    'On macOS: brew install node@24, then rerun the same make command.' \
	    'With nvm: nvm install && nvm use.' >&2; exit 1 ;; \
	esac; \
	if ! command -v "$(PNPM)" >/dev/null 2>&1; then \
	  printf '%s\n' 'pnpm is missing. Install it with: npm install --global pnpm@11.25.0' >&2; \
	  exit 1; \
	fi

install: check-runtime
	$(PNPM) install --frozen-lockfile

sync: check-runtime
	@set -eu; \
	if [ -f .generated/content/registry.json ]; then \
	  set -- --baseline=.generated/content/registry.json; \
	else \
	  set -- --bootstrap; \
	fi; \
	"$(NODE)" --env-file=.env.local --import tsx scripts/content/prepare.ts --source=notion "$$@"

# Keep the dev server after sync, including when make is invoked with -j.
preview: sync
	$(PNPM) dev --port "$(PORT)"

dev: check-runtime
	@if [ ! -f .generated/content/manifest.json ]; then \
	  printf '%s\n' 'No local snapshot yet. Run make preview to sync Notion and start the website.' >&2; \
	  exit 1; \
	fi
	$(PNPM) dev --port "$(PORT)"

check: check-runtime
	$(PNPM) check

deploy-relay: check-runtime
	"$(NODE)" --env-file=.env.local integrations/notion-publish/deploy.mjs

notion-status: check-runtime
	"$(NODE)" --env-file=.env.local --import tsx scripts/notion/sync-status.ts
