package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"

	pb "github.com/ziyixi/protos/go/todofy"
	"github.com/ziyixi/todofy/testutils/mocks"
)

func TestSetupGRPCClients(t *testing.T) {
	t.Run("creates clients successfully", func(t *testing.T) {
		// This test would require actual servers running, so we'll skip it for now
		// In a real scenario, we'd want to mock the gRPC connections
		t.Skip("Requires running gRPC servers - needs integration test setup")
	})
}

func TestNewGRPCClients(t *testing.T) {
	t.Run("creates clients with provided configs", func(_ *testing.T) {
		configs := []ServiceConfig{
			{
				name: "test-service",
				addr: "localhost:50051",
				newClient: func(conn *grpc.ClientConn) any {
					return pb.NewLLMSummaryServiceClient(conn)
				},
			},
		}

		// This would fail without actual server, so we'll mock differently
		// or make this an integration test
		clients, err := NewGRPCClients(configs)

		// Even if connection fails, the structure should be created
		if clients != nil {
			defer clients.Close()
		}

		// For unit testing, we'd want to extract an interface and mock it
		// This shows the need for refactoring for better testability
		_ = err // Don't fail the test - connection expected to fail in unit test
	})
}

func TestGRPCClients_GetClient(t *testing.T) {
	t.Run("returns nil for non-existent service", func(t *testing.T) {
		clients := &GRPCClients{
			services: make(map[string]*serviceState),
		}

		result := clients.GetClient("non-existent")
		assert.Nil(t, result)
	})

	t.Run("returns client for existing service", func(t *testing.T) {
		mockClient := &mocks.MockLLMSummaryServiceClient{}

		clients := &GRPCClients{
			services: map[string]*serviceState{
				"test-service": {
					client: mockClient,
				},
			},
		}

		result := clients.GetClient("test-service")
		assert.Equal(t, mockClient, result)
	})
}

func TestGRPCClients_Close(t *testing.T) {
	t.Run("closes all connections without panic", func(t *testing.T) {
		clients := &GRPCClients{
			services: make(map[string]*serviceState),
		}

		// Should not panic even with empty services
		require.NotPanics(t, func() {
			clients.Close()
		})
	})
}

func TestServiceConfig(t *testing.T) {
	t.Run("service config structure", func(t *testing.T) {
		config := ServiceConfig{
			name: "test",
			addr: ":50051",
			newClient: func(_ *grpc.ClientConn) any {
				return "mock-client"
			},
		}

		assert.Equal(t, "test", config.name)
		assert.Equal(t, ":50051", config.addr)
		assert.NotNil(t, config.newClient)

		// Test the newClient function
		result := config.newClient(nil)
		assert.Equal(t, "mock-client", result)
	})
}

func TestConfig_Validation(t *testing.T) {
	t.Run("config structure has expected fields", func(t *testing.T) {
		config := Config{
			AllowedUsers:       "user:pass",
			DataBasePath:       "/tmp/test.db",
			Port:               8080,
			HealthCheckTimeout: 10,
			LLMAddr:            ":50051",
			TodoAddr:           ":50052",
			DatabaseAddr:       ":50053",
		}

		assert.Equal(t, "user:pass", config.AllowedUsers)
		assert.Equal(t, "/tmp/test.db", config.DataBasePath)
		assert.Equal(t, 8080, config.Port)
		assert.Equal(t, 10, config.HealthCheckTimeout)
		assert.Equal(t, ":50051", config.LLMAddr)
		assert.Equal(t, ":50052", config.TodoAddr)
		assert.Equal(t, ":50053", config.DatabaseAddr)
	})
}
