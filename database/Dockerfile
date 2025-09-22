# database/Dockerfile

# Stage 1: Builder
# Using golang image based on Debian Bookworm which includes build tools (gcc)
FROM golang:1.25.1-bookworm AS builder

# Install SQLite development libraries required for Cgo linking
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Set working directory inside the container
WORKDIR /app

# Copy go.mod and go.sum from the project root
# Assumes the build context is the root of the 'todofy' project
COPY go.mod go.sum ./
# Download dependencies for the entire module
RUN go mod download

# Copy all source code from the project root into the builder
# This makes all packages, including 'database', available
COPY . .

# Argument for Git commit hash (optional, but good for versioning)
# Pass during build: --build-arg GIT_COMMIT=$(git rev-parse HEAD)
ARG GIT_COMMIT=unknown
# Fallback if .git directory is available in the build context and GIT_COMMIT wasn't provided
RUN if [ "$GIT_COMMIT" = "unknown" ] && [ -d .git ]; then export GIT_COMMIT=$(git rev-parse HEAD); fi

# Build the 'database' application
# - The target is './database' which refers to the database package in /app/database.
# - Output binary is named '/database_service_executable' (this path is within the builder stage).
# - CGO_ENABLED=1 is implicitly used as we haven't disabled it and installed build tools.
# - Assumes database/database.go (or another file) contains 'package main'.
# - If you use GitCommit, ensure 'var GitCommit string' is in your database's main package.
RUN go build -v \
    -ldflags="-X 'main.GitCommit=${GIT_COMMIT}'" \
    -o /database_service_executable ./database
    # Note: The output path for the binary in this builder stage is '/database_service_executable'.

# Stage 2: Runtime
# Using Debian Bookworm slim for a lean runtime environment
FROM debian:bookworm-slim AS runtime

LABEL org.opencontainers.image.authors="docker@ziyixi.science"
LABEL org.opencontainers.image.source="https://github.com/ziyixi/todofy"
LABEL org.opencontainers.image.description="Todofy (database) is a subpackage of Todofy for task database management."
LABEL org.opencontainers.image.licenses="MIT"

ENV PORT=50053

# Install runtime dependencies: ca-certificates, tzdata, and sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    sqlite3 \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Copy the built binary from the builder stage directly to /database in the runtime image.
COPY --from=builder /database_service_executable /database

# Copy the entrypoint.sh script for the database service.
# This path is relative to the build context (todofy project root).
# It's copied to /entrypoint.sh in the runtime image.
COPY database/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose the port the database service will run on
EXPOSE 50053

# Define the entrypoint for the container.
# This will execute /entrypoint.sh.
# Inside entrypoint.sh, the command '/database' will now correctly refer to the binary.
ENTRYPOINT ["/entrypoint.sh"]
