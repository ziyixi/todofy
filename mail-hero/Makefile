NPM ?= npm
NODE ?= node

.PHONY: install ui build check test test-worker test-web dev dev-web

install:
	$(NPM) ci --prefix cloudflare
	$(NPM) ci --prefix web

ui:
	$(NPM) run build --prefix web

build: ui
	cd cloudflare && $(NPM) exec -- wrangler deploy --dry-run --config wrangler.native.toml

check:
	$(NPM) run typecheck --prefix cloudflare
	$(NPM) run typecheck --prefix web
	$(NODE) --test deploy/test/*.test.mjs

test: check test-worker test-web

test-worker:
	$(NPM) test --prefix cloudflare

test-web:
	$(NPM) test --prefix web

dev:
	$(NPM) run dev --prefix cloudflare

dev-web:
	$(NPM) run dev --prefix web
