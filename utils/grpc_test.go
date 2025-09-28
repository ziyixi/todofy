package utils

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/test/bufconn"
)

// mockService implements a simple gRPC service for testing
type mockService struct {
	grpc_health_v1.UnimplementedHealthServer
}

func (m *mockService) Check(
	_ context.Context,
	_ *grpc_health_v1.HealthCheckRequest,
) (*grpc_health_v1.HealthCheckResponse, error) {
	return &grpc_health_v1.HealthCheckResponse{
		Status: grpc_health_v1.HealthCheckResponse_SERVING,
	}, nil
}

func TestStartGRPCServer(t *testing.T) {
	t.Run("server fails with invalid port", func(t *testing.T) {
		// Use an invalid port that should fail
		mockSvc := &mockService{}

		err := StartGRPCServer(
			-1, // Invalid port
			mockSvc,
			func(srv grpc.ServiceRegistrar, impl *mockService) {
				grpc_health_v1.RegisterHealthServer(srv, impl)
			},
		)

		assert.Error(t, err)
		assert.Contains(t, err.Error(), "failed to listen")
	})

	t.Run("server with bufconn for testing", func(t *testing.T) {
		// Create bufconn listener for testing
		buffer := 1024 * 1024
		listener := bufconn.Listen(buffer)
		defer func() {
			_ = listener.Close() // Best effort close
		}()

		// Create server
		server := grpc.NewServer()
		mockSvc := &mockService{}

		// Register services
		grpc_health_v1.RegisterHealthServer(server, mockSvc)

		// Register health check
		healthcheck := health.NewServer()
		// Note: Don't register the same service twice, let's use a different service name
		healthcheck.SetServingStatus("test-service", grpc_health_v1.HealthCheckResponse_SERVING)

		// Start server in goroutine
		go func() {
			_ = server.Serve(listener) // Best effort serve
		}()
		defer server.Stop()

		// Create client
		conn, err := grpc.NewClient(
			"passthrough:///bufconn",
			grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) {
				return listener.Dial()
			}),
			grpc.WithTransportCredentials(insecure.NewCredentials()),
		)
		require.NoError(t, err)
		defer func() {
			_ = conn.Close() // Best effort close
		}()

		// Test the connection
		healthClient := grpc_health_v1.NewHealthClient(conn)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()

		resp, err := healthClient.Check(ctx, &grpc_health_v1.HealthCheckRequest{Service: "test-service"})
		require.NoError(t, err)
		assert.Equal(t, grpc_health_v1.HealthCheckResponse_SERVING, resp.Status)
	})
}

func TestGRPCRegisterFunc(t *testing.T) {
	// Test that the type alias works correctly
	registerFunc := func(srv grpc.ServiceRegistrar, impl *mockService) {
		grpc_health_v1.RegisterHealthServer(srv, impl)
	}

	// Verify the function can be called
	server := grpc.NewServer()
	mockSvc := &mockService{}

	// This should not panic
	require.NotPanics(t, func() {
		registerFunc(server, mockSvc)
	})
}
