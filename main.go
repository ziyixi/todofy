package main

import (
	"context"
	"flag"
	"fmt"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
	"github.com/ziyixi/todofy/utils"
	"google.golang.org/grpc"

	pb "github.com/ziyixi/protos/go/todofy"
)

var log = logrus.New()

func init() {
	log.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})
}

// Config holds all configuration parameters
type Config struct {
	AllowedUsers       string
	DataBasePath       string
	Port               int
	HealthCheckTimeout int
	LLMAddr            string
	TodoAddr           string
	DatabaseAddr       string
}

var (
	config    Config
	GitCommit string // Will be set by Bazel at build time
)

func init() {
	flag.StringVar(&config.AllowedUsers, "allowed-users", "", "Comma-separated list of allowed users in the format 'username:password'")
	flag.StringVar(&config.DataBasePath, "database-path", "", "Path to the SQLite database file")
	flag.IntVar(&config.Port, "port", 8080, "Port to run the server on")
	flag.IntVar(&config.HealthCheckTimeout, "health-check-timeout", 10, "Timeout for health check in seconds")

	// GRPC addresses for the services
	flag.StringVar(&config.LLMAddr, "llm-addr", ":50051", "Address of the LLM server")
	flag.StringVar(&config.TodoAddr, "todo-addr", ":50052", "Address of the Todo server")
	flag.StringVar(&config.DatabaseAddr, "database-addr", ":50053", "Address of the Database server")
}

func setupGRPCClients() (*GRPCClients, error) {
	serviceConfigs := []ServiceConfig{
		{
			name: "llm",
			addr: config.LLMAddr,
			newClient: func(conn *grpc.ClientConn) interface{} {
				return pb.NewLLMSummaryServiceClient(conn)
			},
		},
		{
			name: "todo",
			addr: config.TodoAddr,
			newClient: func(conn *grpc.ClientConn) interface{} {
				return pb.NewTodoServiceClient(conn)
			},
		},
		{
			name: "database",
			addr: config.DatabaseAddr,
			newClient: func(conn *grpc.ClientConn) interface{} {
				return pb.NewDataBaseServiceClient(conn)
			},
		},
	}

	clients, err := NewGRPCClients(serviceConfigs)
	if err != nil {
		return nil, fmt.Errorf("failed to create gRPC clients: %w", err)
	}

	return clients, nil
}

func setupRouter(allowedUsers gin.Accounts, grpcClients *GRPCClients) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	app := gin.Default()

	api := app.Group("/api", gin.BasicAuth(allowedUsers))
	api.Use(grpcMiddleware(grpcClients))
	api.GET("/summary", HandleSummary)

	v1 := api.Group("/v1")
	v1.Use(utils.RateLimitMiddleware())

	v1.POST("/update_todo", HandleUpdateTodo)

	return app
}

func main() {
	log.Infof("Server Starting time: %s", time.Now().Format(time.RFC3339))
	flag.Parse()

	if config.AllowedUsers == "" {
		log.Fatal("No allowed users provided. Use --allowed-users flag to specify them.")
	}

	// Setup gRPC clients
	grpcClients, err := setupGRPCClients()
	if err != nil {
		log.Fatalf("Failed to create gRPC clients: %v", err)
	}
	defer grpcClients.Close()

	// Wait for healthy services
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(config.HealthCheckTimeout)*time.Second)
	defer cancel()

	if err := grpcClients.WaitForHealthy(ctx, time.Duration(config.HealthCheckTimeout)*time.Second); err != nil {
		log.Fatalf("Failed to connect to gRPC services: %v", err)
	}
	var servicesNames []string
	for name := range grpcClients.services {
		servicesNames = append(servicesNames, name)
	}

	log.Infof("Connected to gRPC services: %v", servicesNames)
	if config.DataBasePath == "" {
		log.Fatal("No database path provided. Use --database-path flag to specify it.")
	}
	grpcClients.SetUpDataBase(config.DataBasePath)
	log.Infof("Database successfully set up at %s", config.DataBasePath)

	// Parse and validate allowed users
	allowedUserMap, allowedUsersStrings := utils.ParseAllowedUsers(config.AllowedUsers)
	if len(allowedUserMap) == 0 {
		log.Fatal("No valid users found in the allowed users list.")
	}
	log.Infof("Allowed users (hidden passwords): %s", allowedUsersStrings)

	// Setup and start the server
	app := setupRouter(allowedUserMap, grpcClients)
	listenAddr := fmt.Sprintf(":%d", config.Port)
	log.Infof("Git commit: %s", GitCommit)
	log.Infof("Gin has started in %s mode on %s", gin.Mode(), listenAddr)

	if err := app.Run(listenAddr); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
