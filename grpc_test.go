package main

import (
	"context"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"github.com/ziyixi/todofy/testutils/mocks"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	pb "github.com/ziyixi/protos/go/todofy"
)

func TestNewGRPCClients(t *testing.T) {
	t.Run("empty config creates empty clients", func(t *testing.T) {
		clients, err := NewGRPCClients(nil)
		require.NoError(t, err)
		require.NotNil(t, clients)
		assert.Empty(t, clients.services)
	})

	t.Run("registers service state when connection succeeds", func(t *testing.T) {
		grpcNewClient = func(string, ...grpc.DialOption) (*grpc.ClientConn, error) {
			return &grpc.ClientConn{}, nil
		}
		t.Cleanup(func() {
			grpcNewClient = grpc.NewClient
		})

		clients, err := NewGRPCClients([]ServiceConfig{{
			name: "configured-service",
			addr: "ignored",
			newClient: func(_ *grpc.ClientConn) any {
				return "client"
			},
		}})
		require.NoError(t, err)
		require.NotNil(t, clients)
		assert.Contains(t, clients.services, "configured-service")
		assert.Equal(t, "client", clients.GetClient("configured-service"))
	})

	t.Run("returns wrapped error when connection fails", func(t *testing.T) {
		grpcNewClient = func(string, ...grpc.DialOption) (*grpc.ClientConn, error) {
			return nil, status.Error(codes.Unavailable, "dial failed")
		}
		t.Cleanup(func() {
			grpcNewClient = grpc.NewClient
		})

		clients, err := NewGRPCClients([]ServiceConfig{{
			name: "llm",
			addr: "ignored",
			newClient: func(_ *grpc.ClientConn) any {
				return "client"
			},
		}})
		require.Error(t, err)
		assert.Nil(t, clients)
		assert.Contains(t, err.Error(), "failed to connect to llm server")
	})
}

func TestGRPCClients_GetClient(t *testing.T) {
	clients := &GRPCClients{services: map[string]*serviceState{}}
	assert.Nil(t, clients.GetClient("missing"))

	mockClient := &mocks.MockLLMSummaryServiceClient{}
	clients.services["llm"] = &serviceState{client: mockClient}
	assert.Equal(t, mockClient, clients.GetClient("llm"))
}

func TestGRPCClients_Close(t *testing.T) {
	clients := &GRPCClients{services: map[string]*serviceState{}}
	require.NotPanics(t, func() {
		clients.Close()
	})
}

func TestGRPCClients_ServiceNames(t *testing.T) {
	clients := &GRPCClients{
		services: map[string]*serviceState{
			"llm":      {},
			"todo":     {},
			"database": {},
		},
	}
	names := clients.ServiceNames()
	assert.ElementsMatch(t, []string{"llm", "todo", "database"}, names)
}

func newBufconnConn(t *testing.T, registerHealth bool) (*grpc.ClientConn, func()) {
	t.Helper()

	listener := bufconn.Listen(1024 * 1024)
	server := grpc.NewServer()
	if registerHealth {
		healthServer := health.NewServer()
		healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)
		grpc_health_v1.RegisterHealthServer(server, healthServer)
	}

	go func() {
		_ = server.Serve(listener)
	}()

	conn, err := grpc.NewClient(
		"passthrough:///bufconn",
		grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) {
			return listener.Dial()
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)

	cleanup := func() {
		require.NoError(t, conn.Close())
		server.Stop()
		require.NoError(t, listener.Close())
	}

	return conn, cleanup
}

func TestGRPCClients_WaitForHealthy(t *testing.T) {
	t.Run("returns nil when all services are serving", func(t *testing.T) {
		conn, cleanup := newBufconnConn(t, true)
		defer cleanup()

		clients := &GRPCClients{
			services: map[string]*serviceState{
				"healthy": {conn: conn},
			},
		}

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		require.NoError(t, clients.WaitForHealthy(ctx))
	})

	t.Run("returns error on timeout", func(t *testing.T) {
		conn, cleanup := newBufconnConn(t, false)
		defer cleanup()

		clients := &GRPCClients{
			services: map[string]*serviceState{
				"unhealthy": {conn: conn},
			},
		}

		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()

		err := clients.WaitForHealthy(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "health check failed")
		assert.Contains(t, err.Error(), "unhealthy")
	})

	t.Run("returns nil when no services configured", func(t *testing.T) {
		clients := &GRPCClients{services: map[string]*serviceState{}}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		require.NoError(t, clients.WaitForHealthy(ctx))
	})
}

func TestSetUpDataBase(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		mockDB := new(mocks.MockDataBaseServiceClient)
		mockDB.On("CreateIfNotExist", mock.Anything, mock.Anything, mock.Anything).
			Return(&pb.CreateIfNotExistResponse{}, nil)

		clients := &GRPCClients{
			services: map[string]*serviceState{
				"database": {client: mockDB},
			},
		}

		err := clients.SetUpDataBase("/tmp/test.db")
		assert.NoError(t, err)
		mockDB.AssertExpectations(t)
	})

	t.Run("rpc error", func(t *testing.T) {
		mockDB := new(mocks.MockDataBaseServiceClient)
		mockDB.On("CreateIfNotExist", mock.Anything, mock.Anything, mock.Anything).
			Return(nil, fmt.Errorf("connection refused"))

		clients := &GRPCClients{
			services: map[string]*serviceState{
				"database": {client: mockDB},
			},
		}

		err := clients.SetUpDataBase("/tmp/test.db")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "failed to set up database")
		assert.Contains(t, err.Error(), "connection refused")
		mockDB.AssertExpectations(t)
	})

	t.Run("missing database client", func(t *testing.T) {
		clients := &GRPCClients{services: map[string]*serviceState{}}
		err := clients.SetUpDataBase("/tmp/test.db")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "database client is not configured")
	})

	t.Run("wrong database client type", func(t *testing.T) {
		clients := &GRPCClients{
			services: map[string]*serviceState{
				"database": {client: "not-a-database-client"},
			},
		}

		err := clients.SetUpDataBase("/tmp/test.db")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "database client has unexpected type")
	})
}
