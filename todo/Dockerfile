# todo/Dockerfile

# Stage 1: Builder
# Using golang:1.25.1-alpine3.22 for a lightweight builder environment
FROM golang:1.25.1-alpine3.22 AS builder

# Install build essentials like git for fetching commit hash if needed, though often not strictly necessary
# if GIT_COMMIT is passed as a build-arg. Alpine images are minimal.
# RUN apk add --no-cache git

# Set working directory inside the container
WORKDIR /app

# Copy go.mod and go.sum from the project root
# Assumes the build context is the root of the 'todofy' project
COPY go.mod go.sum ./
# Download dependencies for the entire module
RUN go mod download

# Copy all source code from the project root into the builder
# This makes all packages, including 'todo', available
COPY . .

# Argument for Git commit hash (optional, but good for versioning)
# Pass during build: --build-arg GIT_COMMIT=$(git rev-parse HEAD)
ARG GIT_COMMIT=unknown
# Fallback if .git directory is available in the build context and GIT_COMMIT wasn't provided
# Note: For this to work, the .git directory must be copied into the builder,
# or GIT_COMMIT must be passed as a build argument.
RUN if [ "$GIT_COMMIT" = "unknown" ] && [ -d .git ]; then export GIT_COMMIT=$(git rev-parse HEAD); fi

# Build the 'todo' application
# - The target is './todo' which refers to the todo package in /app/todo.
# - Output binary is named '/todo_service_executable' (this path is within the builder stage).
# - CGO_ENABLED=0 to build a static binary without C dependencies.
# - Assumes todo/todo.go (or another file) contains 'package main'.
# - If you use GitCommit, ensure 'var GitCommit string' is in your todo's main package.
RUN CGO_ENABLED=0 GOOS=linux go build -v \
    -ldflags="-X 'main.GitCommit=${GIT_COMMIT}' -s -w" \
    -o /todo_service_executable ./todo
    # Note: The output path for the binary in this builder stage is '/todo_service_executable'.
    # -s -w flags are added to strip debug symbols and DWARF information, reducing binary size.

# Stage 2: Runtime
# Using alpine:latest for a minimal runtime image.
# For production, consider pinning to a specific version (e.g., alpine:3.20 or current stable).
FROM alpine:latest

LABEL org.opencontainers.image.authors="docker@ziyixi.science"
LABEL org.opencontainers.image.source="https://github.com/ziyixi/todofy"
LABEL org.opencontainers.image.description="Todofy (todo) is a subpackage of Todofy for email/API populating tasks."
LABEL org.opencontainers.image.licenses="MIT"

ENV PORT=50052
ENV MAILJET_API_KEY_PUBLIC=""
ENV MAILJET_API_KEY_PRIVATE=""
ENV TARGET_EMAIL=""
ENV NOTION_API_KEY=""
ENV NOTION_DATABASE_ID=""
ENV TODOIST_API_KEY=""
ENV TODOIST_PROJECT_ID=""

# Install ca-certificates for HTTPS and tzdata for timezone information
RUN apk --no-cache add ca-certificates tzdata

# Install grpc_health_probe for container health checks
RUN GRPC_HEALTH_PROBE_VERSION=v0.4.28 && \
    wget -qO/grpc_health_probe https://github.com/grpc-ecosystem/grpc-health-probe/releases/download/${GRPC_HEALTH_PROBE_VERSION}/grpc_health_probe-linux-amd64 && \
    chmod +x /grpc_health_probe

# Copy the built binary from the builder stage directly to /todo in the runtime image.
COPY --from=builder /todo_service_executable /todo

# Copy the entrypoint.sh script for the todo service.
# This path is relative to the build context (todofy project root).
# It's copied to /entrypoint.sh in the runtime image.
COPY todo/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose the port the todo service will run on
EXPOSE 50052

# Define the entrypoint for the container.
# This will execute /entrypoint.sh.
# Inside entrypoint.sh, the command '/todo' will now correctly refer to the binary.
ENTRYPOINT ["/entrypoint.sh"]
