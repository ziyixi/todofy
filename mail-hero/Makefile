GO ?= go
NPM ?= npm
DOCKER ?= docker
GO_CACHE ?= /tmp/mailhero-gocache

.PHONY: ui build test test-go test-web vet local-init local-db local-stop local-run compose-config

ui:
	cd web && $(NPM) ci && $(NPM) run build

build: ui
	mkdir -p bin
	GOCACHE=$(GO_CACHE) CGO_ENABLED=0 $(GO) build -trimpath -o bin/mail-hero ./cmd/mail-hero

test: ui test-go test-web

test-go:
	GOCACHE=$(GO_CACHE) $(GO) test ./...

test-web:
	cd web && $(NPM) test

vet:
	GOCACHE=$(GO_CACHE) $(GO) vet ./...

local-init:
	./deploy/bootstrap-local.sh

local-db:
	$(DOCKER) compose -f deploy/compose.local.yaml up -d db

local-stop:
	$(DOCKER) compose -f deploy/compose.local.yaml down

local-run: ui
	@test -f deploy/local.env || { echo 'Run make local-init first'; exit 1; }
	set -a; . ./deploy/local.env; set +a; GOCACHE=$(GO_CACHE) $(GO) run ./cmd/mail-hero serve

compose-config:
	$(DOCKER) compose --env-file deploy/runtime.env -f deploy/compose.yaml config --quiet
