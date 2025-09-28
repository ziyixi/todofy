# Todofy Makefile

.PHONY: test test-coverage test-verbose test-integration build clean lint security help

# Default target
help: ## Show this help message
	@echo "Available targets:"
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# Testing targets
test: ## Run all unit tests
	go test ./...

test-coverage: ## Run tests with coverage report
	go test -coverprofile=coverage.out ./...
	go tool cover -func=coverage.out
	go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

test-verbose: ## Run tests with verbose output
	go test -v ./...

test-integration: ## Run integration tests
	./scripts/integration-test.sh

# Code quality targets
lint: ## Run golangci-lint
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
dev-setup: ## Install development dependencies
	go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
	go install github.com/securecodewarrior/gosec/v2/cmd/gosec@latest

# CI targets (used by GitHub Actions)
ci-test: test-coverage lint security ## Run all CI checks
	@echo "All CI checks completed successfully"
