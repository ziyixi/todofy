// Package testutils provides common utilities for testing across the todofy project
package testutils

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"os"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// NewTestDB creates an in-memory SQLite database for testing
func NewTestDB(t *testing.T) *gorm.DB {
	t.Helper()

	db, err := gorm.Open(sqlite.Open("file::memory:?cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatalf("Failed to create test database: %v", err)
	}

	return db
}

// CloseTestDB closes the test database connection
func CloseTestDB(t *testing.T, db *gorm.DB) {
	t.Helper()

	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("Failed to get SQL DB from GORM: %v", err)
	}

	if err := sqlDB.Close(); err != nil {
		t.Fatalf("Failed to close test database: %v", err)
	}
}

// BufDialer returns a dialer function for testing gRPC services
func BufDialer(listener *bufconn.Listener) func(context.Context, string) (net.Conn, error) {
	return func(context.Context, string) (net.Conn, error) {
		return listener.Dial()
	}
}

// NewTestGRPCServer creates a test gRPC server with bufconn for testing
func NewTestGRPCServer(t *testing.T) (*grpc.Server, *bufconn.Listener) {
	t.Helper()

	buffer := 101024 * 1024
	listener := bufconn.Listen(buffer)

	baseServer := grpc.NewServer()

	return baseServer, listener
}

// NewTestGRPCClient creates a test gRPC client connected to a bufconn listener
func NewTestGRPCClient(t *testing.T, listener *bufconn.Listener) *grpc.ClientConn {
	t.Helper()

	conn, err := grpc.NewClient(
		"passthrough:///bufconn",
		grpc.WithContextDialer(BufDialer(listener)),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("Failed to create test gRPC client: %v", err)
	}

	return conn
}

// TempFile creates a temporary file for testing
func TempFile(t *testing.T, prefix string) *os.File {
	t.Helper()

	file, err := os.CreateTemp("", prefix)
	if err != nil {
		t.Fatalf("Failed to create temp file: %v", err)
	}

	t.Cleanup(func() {
		_ = file.Close()           // Best effort close
		_ = os.Remove(file.Name()) // Best effort cleanup
	})

	return file
}

// TempDir creates a temporary directory for testing
func TempDir(t *testing.T, prefix string) string {
	t.Helper()

	dir, err := os.MkdirTemp("", prefix)
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}

	t.Cleanup(func() {
		_ = os.RemoveAll(dir) // Best effort cleanup
	})

	return dir
}

// SetEnv sets an environment variable for the duration of a test
func SetEnv(t *testing.T, key, value string) {
	t.Helper()

	oldValue := os.Getenv(key)
	_ = os.Setenv(key, value) // Best effort

	t.Cleanup(func() {
		if oldValue == "" {
			_ = os.Unsetenv(key) // Best effort
		} else {
			_ = os.Setenv(key, oldValue) // Best effort
		}
	})
}

// MockDB creates a mock database connection for testing
type MockDB struct {
	*sql.DB
}

// NewMockDB creates a new mock database connection
func NewMockDB(t *testing.T) (*MockDB, error) {
	t.Helper()

	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		return nil, fmt.Errorf("failed to open mock database: %w", err)
	}

	t.Cleanup(func() {
		_ = db.Close() // Best effort close
	})

	return &MockDB{DB: db}, nil
}
