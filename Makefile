# Todofy Makefile

.PHONY: test test-coverage test-verbose test-integration test-sut build clean lint lint-check security help install-hooks

COVERAGE_PACKAGES = $(shell go list ./... | grep -vE '^github.com/ziyixi/todofy/(sut|testutils)(/|$$)')

# Default target
help: ## Show this help message
	@echo "Available targets:"
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# Testing targets
test: ## Run all unit tests
	go test ./...

test-coverage: ## Run tests with coverage report
	go test -coverprofile=coverage.out $(COVERAGE_PACKAGES)
	go tool cover -func=coverage.out
	go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

test-verbose: ## Run tests with verbose output
	go test -v ./...

test-integration: ## Run docker-compose.test.yml integration checks locally
	@set -eu; \
	docker compose -f docker-compose.test.yml build; \
	docker compose -f docker-compose.test.yml up -d; \
	trap 'docker compose -f docker-compose.test.yml down -v' EXIT; \
	timeout=120; \
	elapsed=0; \
	echo "Waiting for all services to be healthy..."; \
	while [ $$elapsed -lt $$timeout ]; do \
		all_healthy=true; \
		for service in todofy-llm-test todofy-todo-test todofy-database-test todofy-test; do \
			status=$$(docker inspect --format='{{.State.Health.Status}}' $$service 2>/dev/null || echo "not_found"); \
			if [ "$$status" != "healthy" ]; then \
				all_healthy=false; \
				echo "  $$service: $$status"; \
			else \
				echo "  $$service: healthy"; \
			fi; \
		done; \
		if [ "$$all_healthy" = true ]; then \
			break; \
		fi; \
		sleep 5; \
		elapsed=$$((elapsed + 5)); \
	done; \
	if [ $$elapsed -ge $$timeout ]; then \
		echo "Timeout waiting for services to become healthy"; \
		docker compose -f docker-compose.test.yml logs; \
		exit 1; \
	fi; \
	response=$$(curl -s -o /dev/null -w "%{http_code}" http://localhost:10003/health); \
	test "$$response" = "200"; \
	body=$$(curl -s http://localhost:10003/health); \
	printf '%s' "$$body" | grep -q '"status":"healthy"'; \
	summary_status=$$(curl -s -o /dev/null -w "%{http_code}" http://localhost:10003/api/summary); \
	test "$$summary_status" = "401"; \
	update_todo_status=$$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:10003/api/v1/update_todo); \
	test "$$update_todo_status" = "401"; \
	dependency_reconcile_status=$$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:10003/api/v1/dependency/reconcile); \
	test "$$dependency_reconcile_status" = "401"; \
	webhook_response=$$(curl -s -w '\n%{http_code}' \
		-X POST \
		-H "Content-Type: application/json" \
		-d '{"event_data":{"id":"integration-task","content":"Integration task <k:int-task>"}}' \
		http://localhost:10003/api/v1/todoist/webhook); \
	webhook_status=$$(printf '%s\n' "$$webhook_response" | tail -n1); \
	webhook_body=$$(printf '%s\n' "$$webhook_response" | sed '$$d'); \
	test "$$webhook_status" = "200"; \
	printf '%s' "$$webhook_body" | grep -q '"accepted":false'; \
	docker exec todofy-llm-test /grpc_health_probe -addr=:50051 >/dev/null; \
	docker exec todofy-todo-test /grpc_health_probe -addr=:50052 >/dev/null; \
	docker exec todofy-database-test /grpc_health_probe -addr=:50053 >/dev/null; \
	echo "Integration checks passed"

test-sut: ## Run system-under-test integration tests against a running docker-compose.sut.yml stack
	TODOFY_RUN_SUT=1 go test -v ./sut/...

# Code quality targets
lint: ## Auto-fix lint/format issues, then verify
	gofmt -w $(shell find . -name '*.go' -not -path './vendor/*')
	-golangci-lint run --fix
	$(MAKE) lint-check

lint-check: ## Run golangci-lint without applying fixes
	golangci-lint run

security: ## Run security analysis with gosec
	gosec ./...

# Build targets
build: ## Build all services
	@echo "Building main service..."
	go build -o bin/main ./main.go
	@echo "Building database service..."
	go build -o bin/database ./database/
	@echo "Building LLM service..."
	go build -o bin/llm ./llm/
	@echo "Building TODO service..."
	go build -o bin/todo ./todo/

# Docker targets
docker-build: ## Build all Docker images
	docker build -t todofy:latest .
	docker build -t todofy-database:latest -f database/Dockerfile .
	docker build -t todofy-llm:latest -f llm/Dockerfile .
	docker build -t todofy-todo:latest -f todo/Dockerfile .

# Cleanup
clean: ## Clean build artifacts
	rm -rf bin/
	rm -f coverage.out coverage.html
	go clean -testcache

# Development
install-hooks: ## Install git pre-commit hooks for linting
	git config core.hooksPath .githooks
	@echo "Git hooks installed. Pre-commit lint check is now active."

dev-setup: install-hooks ## Install development dependencies and hooks
	go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
	go install github.com/securego/gosec/v2/cmd/gosec@latest

# CI targets (used by GitHub Actions)
ci-test: test-coverage lint-check security ## Run all CI checks
	@echo "All CI checks completed successfully"
