package utils

import (
	"fmt"
	"log"
	"net"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/reflection"

	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

// GRPCRegisterFunc is a type alias for the registration function
type GRPCRegisterFunc[S any] func(grpc.ServiceRegistrar, S)

// StartGRPCServer starts a gRPC server with the given service
func StartGRPCServer[S any](
	port int,
	implementation S,
	registerFunc GRPCRegisterFunc[S],
	opts ...grpc.ServerOption,
) error {
	lis, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return fmt.Errorf("failed to listen: %v", err)
	}

	srv := grpc.NewServer(opts...)
	registerFunc(srv, implementation)
	reflection.Register(srv)

	healthcheck := health.NewServer()
	healthpb.RegisterHealthServer(srv, healthcheck)

	log.Printf("Server is running on port %d", port)
	healthcheck.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)
	if err := srv.Serve(lis); err != nil {
		return fmt.Errorf("failed to serve: %v", err)
	}

	return nil
}
