# Todofy - Self-Hosted Task Management Tool

[![Build Status](https://github.com/ziyixi/todofy/actions/workflows/todofy-build.yml/badge.svg)](https://github.com/ziyixi/todofy/actions/workflows/todofy-build.yml)
[![codecov](https://codecov.io/gh/ziyixi/todofy/graph/badge.svg?token=2Y6YIYUYZP)](https://codecov.io/gh/ziyixi/todofy)

Todofy is a self-hosted task management tool designed to help you organize and prioritize your tasks efficiently. It's built as a collection of services, each handling a specific aspect of the application.

## ✨ Features

* **Task Management:** Core functionality for creating, updating, and managing tasks.
* **LLM Integration:** Leverages Large Language Models for enhanced task processing or insights (via `todofy-llm` service).
* **Email/API Task Population:** Allows tasks to be populated or managed via email or API interactions (via `todofy-todo` service).
* **Persistent Storage:** Uses SQLite for storing task data (via `todofy-database` service).
* **Containerized Services:** All components are containerized using Docker for easy deployment and scaling.

## 🛠️ Services

The application is composed of the following services:

1.  **Todofy (Main App)**
    * Description: The primary user-facing application or orchestrator.
    * Dockerfile: `./Dockerfile`
    * Default Port: `8080` (configurable via `PORT` env var)
    * Image: `ghcr.io/ziyixi/todofy:latest`

2.  **LLM Service (`todofy-llm`)**
    * Description: Handles tasks related to Large Language Models.
    * Dockerfile: `llm/Dockerfile`
    * Default Port: `50051` (configurable via `PORT` env var)
    * Image: `ghcr.io/ziyixi/todofy-llm:latest`

3.  **Todo Service (`todofy-todo`)**
    * Description: Manages task population, potentially via email or other APIs.
    * Dockerfile: `todo/Dockerfile`
    * Default Port: `50052` (configurable via `PORT` env var)
    * Image: `ghcr.io/ziyixi/todofy-todo:latest`

4.  **Database Service (`todofy-database`)**
    * Description: Provides database access and management using SQLite.
    * Dockerfile: `database/Dockerfile`
    * Default Port: `50053` (configurable via `PORT` env var)
    * Image: `ghcr.io/ziyixi/todofy-database:latest`

## 📦 GitHub Packages (GHCR)

Docker images for each service are automatically built and pushed to GitHub Container Registry (GHCR) by the GitHub Actions workflow. You can pull them using:

* docker pull ghcr.io/ziyixi/todofy:latest
* docker pull ghcr.io/ziyixi/todofy-llm:latest
* docker pull ghcr.io/ziyixi/todofy-todo:latest
* docker pull ghcr.io/ziyixi/todofy-database:latest

## 🧪 Testing

This project includes comprehensive unit tests and integration tests with CI/CD automation.

### Test Coverage

Current test coverage is **38.9%** overall:
- **Database service**: 80.6%
- **Utils package**: 80.9%  
- **LLM service**: 61.9%
- **Todoist client**: 83.3%
- **TODO service**: 47.4%

### Running Tests

```bash
# Run all tests
go test ./...

# Run tests with coverage
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out -o coverage.html

# Run tests with verbose output
go test -v ./...

# Run specific package tests
go test ./utils/
go test ./database/
```
