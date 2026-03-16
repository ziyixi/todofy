package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
	"github.com/ziyixi/todofy/utils"
	"google.golang.org/grpc"

	pb "github.com/ziyixi/protos/go/todofy"
)

var log = logrus.New()

// initLogger initializes the logger configuration
func initLogger() {
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
	DependencyAddr     string
	DatabaseAddr       string
}

var (
	config    Config
	GitCommit string // Will be set by Bazel at build time
)

type startupClients interface {
	Close()
	WaitForHealthy(context.Context) error
	SetUpDataBase(path string) error
	ServiceNames() []string
}

type appRunner interface {
	Run(addr ...string) error
}

var (
	newGRPCClientsFunc = NewGRPCClients
	createClients      = func(cfg Config) (startupClients, error) {
		return setupGRPCClients(cfg)
	}
	createRouter = func(allowedUsers gin.Accounts, clients startupClients) (appRunner, error) {
		grpcClients, ok := clients.(*GRPCClients)
		if !ok {
			return nil, fmt.Errorf("unexpected grpc clients type %T", clients)
		}
		return setupRouter(allowedUsers, grpcClients), nil
	}
	runApplication = run
)

// initFlags initializes command line flags
func initFlags() {
	initFlagsWithFlagSet(flag.CommandLine, &config)
}

func initFlagsWithFlagSet(fs *flag.FlagSet, cfg *Config) {
	fs.StringVar(&cfg.AllowedUsers, "allowed-users", "",
		"Comma-separated list of allowed users in the format 'username:password'")
	fs.StringVar(&cfg.DataBasePath, "database-path", "", "Path to the SQLite database file")
	fs.IntVar(&cfg.Port, "port", 8080, "Port to run the server on")
	fs.IntVar(&cfg.HealthCheckTimeout, "health-check-timeout", 10, "Timeout for health check in seconds")

	// GRPC addresses for the services
	fs.StringVar(&cfg.LLMAddr, "llm-addr", ":50051", "Address of the LLM server")
	fs.StringVar(&cfg.TodoAddr, "todo-addr", ":50052", "Address of the Todo server")
	fs.StringVar(&cfg.DependencyAddr, "dependency-addr", "", "Address of the Dependency server (defaults to todo-addr)")
	fs.StringVar(&cfg.DatabaseAddr, "database-addr", ":50053", "Address of the Database server")
}

func buildServiceConfigs(cfg Config) []ServiceConfig {
	return []ServiceConfig{
		{
			name: "llm",
			addr: cfg.LLMAddr,
			newClient: func(conn *grpc.ClientConn) any {
				return pb.NewLLMSummaryServiceClient(conn)
			},
		},
		{
			name: "todo",
			addr: cfg.TodoAddr,
			newClient: func(conn *grpc.ClientConn) any {
				return pb.NewTodoServiceClient(conn)
			},
		},
		{
			name: "database",
			addr: cfg.DatabaseAddr,
			newClient: func(conn *grpc.ClientConn) any {
				return pb.NewDataBaseServiceClient(conn)
			},
		},
		{
			name: "dependency",
			addr: cfg.DependencyAddr,
			newClient: func(conn *grpc.ClientConn) any {
				return pb.NewDependencyServiceClient(conn)
			},
		},
	}
}

func setupGRPCClients(cfg Config) (*GRPCClients, error) {
	clients, err := newGRPCClientsFunc(buildServiceConfigs(cfg))
	if err != nil {
		return nil, fmt.Errorf("failed to create gRPC clients: %w", err)
	}

	return clients, nil
}

func setupRouter(allowedUsers gin.Accounts, grpcClients *GRPCClients) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	app := gin.Default()

	// Add public health endpoint (no auth required)
	app.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{
			"status":    "healthy",
			"timestamp": time.Now().Format(time.RFC3339),
			"service":   "todofy",
		})
	})

	api := app.Group("/api", gin.BasicAuth(allowedUsers))
	api.Use(grpcMiddleware(grpcClients))
	api.GET("/summary", HandleSummary)
	api.GET("/recommendation", HandleRecommendation)

	v1 := api.Group("/v1")
	v1.Use(utils.RateLimitMiddleware())

	v1.POST("/update_todo", HandleUpdateTodo)
	v1.POST("/dependency/reconcile", HandleDependencyReconcile)
	v1.POST("/dependency/bootstrap_keys", HandleDependencyBootstrapMissingKeys)
	v1.POST("/dependency/clear_metadata", HandleDependencyClearMetadata)
	v1.GET("/dependency/status", HandleDependencyStatus)
	v1.GET("/dependency/issues", HandleDependencyIssues)

	return app
}

func validateAllowedUsersFormat(users string) error {
	for _, user := range strings.Split(users, ",") {
		parts := strings.Split(user, ":")
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return fmt.Errorf("invalid user format: %s. expected 'username:password'", user)
		}
	}
	return nil
}

func run(cfg Config) error {
	if cfg.AllowedUsers == "" {
		return errors.New("no allowed users provided. use --allowed-users flag to specify them")
	}
	if err := validateAllowedUsersFormat(cfg.AllowedUsers); err != nil {
		return err
	}
	if cfg.DependencyAddr == "" {
		cfg.DependencyAddr = cfg.TodoAddr
	}

	grpcClients, err := createClients(cfg)
	if err != nil {
		return fmt.Errorf("failed to create gRPC clients: %w", err)
	}
	defer grpcClients.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.HealthCheckTimeout)*time.Second)
	defer cancel()

	if err := grpcClients.WaitForHealthy(ctx); err != nil {
		return fmt.Errorf("failed to connect to gRPC services: %w", err)
	}

	log.Infof("Connected to gRPC services: %v", grpcClients.ServiceNames())
	if cfg.DataBasePath == "" {
		return errors.New("no database path provided. use --database-path flag to specify it")
	}
	if err := grpcClients.SetUpDataBase(cfg.DataBasePath); err != nil {
		return fmt.Errorf("failed to set up database: %w", err)
	}
	log.Infof("Database successfully set up at %s", cfg.DataBasePath)

	allowedUserMap, allowedUsersStrings := utils.ParseAllowedUsers(cfg.AllowedUsers)
	if len(allowedUserMap) == 0 {
		return errors.New("no valid users found in the allowed users list")
	}
	log.Infof("Allowed users (hidden passwords): %s", allowedUsersStrings)

	app, err := createRouter(allowedUserMap, grpcClients)
	if err != nil {
		return fmt.Errorf("failed to create router: %w", err)
	}

	listenAddr := fmt.Sprintf(":%d", cfg.Port)
	log.Infof("Git commit: %s", GitCommit)
	log.Infof("Gin has started in %s mode on %s", gin.Mode(), listenAddr)

	if err := app.Run(listenAddr); err != nil {
		return fmt.Errorf("failed to start server: %w", err)
	}
	return nil
}

func main() {
	os.Exit(executeMain())
}

func executeMain() int {
	initLogger()
	initFlags()
	log.Infof("Server Starting time: %s", time.Now().Format(time.RFC3339))
	flag.Parse()

	if err := runApplication(config); err != nil {
		log.Errorf("Application startup failed: %v", err)
		return 1
	}
	return 0
}
