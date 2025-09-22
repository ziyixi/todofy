# llm/Dockerfile

# Stage 1: Builder
# Using a specific patch version of Go 1.25 for consistency and security
FROM golang:1.25.1-alpine3.22 AS builder

# Set working directory inside the container
WORKDIR /app

# Copy go.mod and go.sum from the project root
# Assumes the build context is the root of the 'todofy' project
COPY go.mod go.sum ./
# Download dependencies for the entire module
RUN go mod download

# Copy all source code from the project root into the builder
# This makes all packages, including 'llm', available
COPY . .

# Argument for Git commit hash (optional, but good for versioning)
# Pass during build: --build-arg GIT_COMMIT=$(git rev-parse HEAD)
ARG GIT_COMMIT=unknown
# Fallback if .git directory is available in the build context and GIT_COMMIT wasn't provided
RUN if [ "$GIT_COMMIT" = "unknown" ] && [ -d .git ]; then export GIT_COMMIT=$(git rev-parse HEAD); fi

# Build the 'llm' application
# - The target is './llm' which refers to the llm package in the /app/llm directory.
# - Output binary is named '/llm' (this path is within the builder stage).
# - Assumes llm/llm.go (or another file in llm/) contains 'package main'.
# - If you use GitCommit, ensure 'var GitCommit string' is in your llm's main package.
RUN CGO_ENABLED=0 GOOS=linux go build -v \
    -ldflags="-X 'main.GitCommit=${GIT_COMMIT}'" \
    -o /llm ./llm
    # Note: The output path for the binary in this builder stage is '/llm'.

# Stage 2: Runtime
# Using alpine:latest for a minimal runtime image.
# For production, consider pinning to a specific version (e.g., alpine:3.20 or current stable).
FROM alpine:latest

LABEL org.opencontainers.image.authors="docker@ziyixi.science"
LABEL org.opencontainers.image.source="https://github.com/ziyixi/todofy"
LABEL org.opencontainers.image.description="Todofy (llm) is a subpackage of Todofy for task management using large language models."
LABEL org.opencontainers.image.licenses="MIT"

ENV PORT=50051
ENV GEMINI_API_KEY=""

# Install ca-certificates for HTTPS and tzdata for timezone information
RUN apk --no-cache add ca-certificates tzdata

# Copy the built binary from the builder stage directly to /llm in the runtime image.
COPY --from=builder /llm /llm

# Copy the entrypoint.sh script for the llm service.
# This path is relative to the build context (todofy project root).
# It's copied to /entrypoint.sh in the runtime image.
COPY llm/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose the port the llm service will run on
EXPOSE 50051

# Define the entrypoint for the container.
# This will execute /entrypoint.sh.
# Inside entrypoint.sh, the command '/llm' will now correctly refer to the binary.
ENTRYPOINT ["/entrypoint.sh"]
