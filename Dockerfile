# Stage 1: Builder
# Using a specific patch version of Go 1.24 for reproducibility and security
FROM golang:1.24.3 AS builder

# Set working directory inside the container
WORKDIR /app

# Copy go.mod and go.sum for dependency caching
# These files are expected to be in the root of the build context (your 'todofy' directory)
COPY go.mod go.sum ./
# Download dependencies
RUN go mod download

# Copy the rest of the source code
# This includes your main.go, subdirectories, and the templates directory
# which is needed by go:embed during the build.
COPY . .

# Get the Git commit hash for stamping
# Best practice is to pass this as a build argument:
# docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) .
ARG GIT_COMMIT=unknown
# Fallback if .git directory is available in the build context and GIT_COMMIT wasn't provided
RUN if [ "$GIT_COMMIT" = "unknown" ] && [ -d .git ]; then export GIT_COMMIT=$(git rev-parse HEAD); fi

# Build the Go application
# - CGO_ENABLED=0: Build a statically linked binary without C dependencies
# - GOOS=linux: Ensure the binary is built for a Linux environment (like Alpine)
# - -a -installsuffix netgo: Force rebuild of stale packages and use netgo dns resolver
# - -ldflags: Embed version information (GitCommit) into the binary
#   Your main package should have a variable like: var GitCommit string
# - -o /todofy: Output the compiled binary to /todofy in this builder stage
# - .: Build the package in the current directory (/app)
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix netgo \
    -ldflags="-X 'main.GitCommit=${GIT_COMMIT}'" \
    -o /todofy .

# Stage 2: Runtime
# Using alpine:latest for a minimal runtime image.
# For production, consider pinning to a specific version, e.g., alpine:3.20 (or current stable)
FROM alpine:latest

LABEL org.opencontainers.image.authors="docker@ziyixi.science"
LABEL org.opencontainers.image.source="https://github.com/ziyixi/monorepo"
LABEL org.opencontainers.image.description="Todofy is a self-hosted task management tool that helps you organize and prioritize your tasks efficiently."
LABEL org.opencontainers.image.licenses="MIT"

ENV PORT=8080
ENV ALLOWED_USERS=""
ENV DATABASE_PATH=""
ENV LLMAddr=":50051"
ENV TodoAddr=":50052"
ENV DatabaseAddr=":50053"

# Install ca-certificates for HTTPS and tzdata for timezone information
RUN apk --no-cache add ca-certificates tzdata

# Set a working directory for the runtime stage (optional but good practice)
WORKDIR /app

# Copy the built binary from the builder stage
# The binary now contains the embedded templates.
COPY --from=builder /todofy /app/todofy

# Copy the entrypoint.sh script
# Ensure entrypoint.sh is in the root of your build context
COPY ./entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Expose the port the application will run on
EXPOSE 8080

# Define the entrypoint for the container
# The script will be responsible for starting the todofy application
ENTRYPOINT ["/app/entrypoint.sh"]