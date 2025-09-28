#!/bin/bash

# Integration test script for todofy services
set -e

echo "Starting integration tests..."

# Build all services
echo "Building services..."
go build -o bin/main ./main.go
go build -o bin/database ./database/
go build -o bin/llm ./llm/
go build -o bin/todo ./todo/

# Start services in background
echo "Starting database service..."
./bin/database &
DATABASE_PID=$!
sleep 2

echo "Starting LLM service..."
./bin/llm &
LLM_PID=$!
sleep 2

echo "Starting TODO service..."
./bin/todo &
TODO_PID=$!
sleep 2

echo "Starting main service..."
./bin/main &
MAIN_PID=$!
sleep 3

# Function to cleanup services
cleanup() {
    echo "Cleaning up services..."
    kill $MAIN_PID $TODO_PID $LLM_PID $DATABASE_PID 2>/dev/null || true
    rm -f bin/main bin/database bin/llm bin/todo
    exit $1
}

trap 'cleanup 1' ERR

# Test health endpoints
echo "Testing service health..."
for service in main database llm todo; do
    port=""
    case $service in
        main) port="8080" ;;
        database) port="50052" ;;
        llm) port="50053" ;;
        todo) port="50054" ;;
    esac
    
    if [ "$service" = "main" ]; then
        if ! curl -s http://localhost:$port/health > /dev/null; then
            echo "Health check failed for $service service"
            cleanup 1
        fi
    else
        # For gRPC services, just check if port is open
        if ! nc -z localhost $port 2>/dev/null; then
            echo "gRPC service $service not responding on port $port"
            cleanup 1
        fi
    fi
    echo "$service service is healthy"
done

echo "All integration tests passed!"
cleanup 0
