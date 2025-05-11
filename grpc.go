package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/ziyixi/todofy/utils"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health/grpc_health_v1"

	pb "github.com/ziyixi/protos/go/todofy"
)

// ServiceConfig holds the configuration for a single gRPC service
type ServiceConfig struct {
	name      string
	addr      string
	newClient func(*grpc.ClientConn) interface{}
}

// GRPCClients manages multiple gRPC client connections
type GRPCClients struct {
	services map[string]*serviceState
	mu       sync.RWMutex
}

type serviceState struct {
	conn   *grpc.ClientConn
	client interface{}
}

func grpcMiddleware(clients *GRPCClients) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(utils.KeyGRPCClients, clients)
		c.Next()
	}
}

// NewGRPCClients creates a new GRPCClients instance with the specified services
func NewGRPCClients(configs []ServiceConfig) (*GRPCClients, error) {
	clients := &GRPCClients{
		services: make(map[string]*serviceState),
	}

	for _, config := range configs {
		conn, err := grpc.NewClient(config.addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			clients.Close() // Clean up any connections already established
			return nil, fmt.Errorf("failed to connect to %s server: %w", config.name, err)
		}

		clients.services[config.name] = &serviceState{
			conn:   conn,
			client: config.newClient(conn),
		}
	}

	return clients, nil
}

// GetClient returns the client for the specified service
func (c *GRPCClients) GetClient(name string) interface{} {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if service, ok := c.services[name]; ok {
		return service.client
	}
	return nil
}

// Close closes all connections
func (c *GRPCClients) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()

	for _, service := range c.services {
		if service.conn != nil {
			service.conn.Close()
		}
	}
}

// WaitForHealthy waits for all services to become healthy
func (c *GRPCClients) WaitForHealthy(ctx context.Context, timeout time.Duration) error {
	c.mu.RLock()
	serviceCount := len(c.services)
	c.mu.RUnlock()

	errChan := make(chan error, serviceCount)
	var wg sync.WaitGroup

	c.mu.RLock()
	for name, service := range c.services {
		wg.Add(1)
		go func(name string, conn *grpc.ClientConn) {
			defer wg.Done()

			healthClient := grpc_health_v1.NewHealthClient(conn)
			ticker := time.NewTicker(500 * time.Millisecond)
			defer ticker.Stop()

			for {
				select {
				case <-ctx.Done():
					errChan <- fmt.Errorf("health check timeout for %s", name)
					return
				case <-ticker.C:
					req := &grpc_health_v1.HealthCheckRequest{}
					resp, err := healthClient.Check(ctx, req)

					if err != nil {
						log.Warningf("Health check error for %s: %v", name, err)
						continue
					}

					if resp.Status == grpc_health_v1.HealthCheckResponse_SERVING {
						errChan <- nil
						return
					}
				}
			}
		}(name, service.conn)
	}
	c.mu.RUnlock()

	go func() {
		wg.Wait()
		close(errChan)
	}()

	var errors []error
	for err := range errChan {
		if err != nil {
			errors = append(errors, err)
		}
	}

	if len(errors) > 0 {
		return fmt.Errorf("health check failed: %v", errors)
	}

	return nil
}

func (c *GRPCClients) SetUpDataBase(path string) error {
	databaseClient := c.GetClient("database").(pb.DataBaseServiceClient)
	req := &pb.CreateIfNotExistRequest{
		Type: pb.DatabaseType_DATABASE_TYPE_SQLITE,
		Path: path,
	}
	_, err := databaseClient.CreateIfNotExist(context.Background(), req)
	if err != nil {
		return fmt.Errorf("failed to set up database: %w", err)
	}
	return nil
}
