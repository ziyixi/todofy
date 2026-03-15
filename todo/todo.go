package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"

	pb "github.com/ziyixi/protos/go/todofy"
	"github.com/ziyixi/todofy/todo/internal/todoist"
)

var log = logrus.New()
var GitCommit string // Will be set by Bazel at build time

// initLogger initializes the logger configuration
func initLogger() {
	log.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})
}

var (
	port = flag.Int("port", 50052, "The server port of the Todo service")

	// Todoist API credentials
	todoistAPIKey           = flag.String("todoist-api-key", "", "The API key for Todoist")
	todoistDefaultProjectID = flag.String(
		"todoist-default-project-id",
		"",
		"Default Todoist project ID for created tasks",
	)
	todoistWebhookSecret = flag.String(
		"todoist-webhook-secret",
		"",
		"The Todoist webhook secret used to verify signatures",
	)
	todoistBaseURL = flag.String(
		"todoist-base-url",
		"",
		"Override base URL for the Todoist API",
	)

	dependencyReconcileInterval = flag.Duration(
		"dependency-reconcile-interval",
		30*time.Minute,
		"How often to run background dependency reconcile",
	)
	dependencyWebhookDebounce = flag.Duration(
		"dependency-webhook-debounce",
		20*time.Second,
		"Debounce duration for webhook-triggered dependency reconcile",
	)
	dependencyGracePeriod = flag.Duration(
		"dependency-grace-period",
		2*time.Minute,
		"Skip task label writes for tasks updated more recently than this duration",
	)
	dependencyEnableScheduler = flag.Bool(
		"dependency-enable-scheduler",
		true,
		"Whether to enable background dependency reconcile scheduling",
	)
	dependencyBootstrapExcludedProjectIDs = flag.String(
		"dependency-bootstrap-excluded-project-ids",
		"",
		"Comma-separated Todoist project IDs to skip when bootstrapping missing task keys",
	)
)

// todoistTaskCreator abstracts the Todoist task creation API for testing.
type todoistTaskCreator interface {
	CreateTask(ctx context.Context, requestID string, taskDetails *todoist.CreateTaskRequest) (*todoist.Task, error)
}

type todoServer struct {
	pb.UnimplementedTodoServiceServer
	newTodoistClient func(apiKey string) todoistTaskCreator
}

const (
	todoistRequestIDPrefix   = "todofy-"
	todoistRequestIDHashSize = 28
)

// PopulateTodo validates the todo target and dispatches creation to the Todoist path.
func (s *todoServer) PopulateTodo(ctx context.Context, req *pb.TodoRequest) (*pb.TodoResponse, error) {
	if req.App != pb.TodoApp_TODO_APP_TODOIST {
		return nil, status.Errorf(codes.InvalidArgument, "unsupported app: %s", req.App)
	}
	if req.Method != pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_TODOIST {
		return nil, status.Errorf(codes.InvalidArgument, "unsupported method %s for app %s", req.Method, req.App)
	}

	return s.PopulateTodoByTodoist(ctx, req)
}

func validateTodoistFlags() error {
	if len(*todoistAPIKey) == 0 {
		return status.Errorf(codes.InvalidArgument, "missing todoist API key")
	}
	return nil
}

// PopulateTodoByTodoist creates a Todoist task from the incoming todo request payload.
func (s *todoServer) PopulateTodoByTodoist(ctx context.Context, req *pb.TodoRequest) (*pb.TodoResponse, error) {
	if err := validateTodoistFlags(); err != nil {
		return nil, err
	}

	factory := s.newTodoistClient
	if factory == nil {
		factory = func(apiKey string) todoistTaskCreator {
			return todoist.NewClientWithBaseURL(apiKey, *todoistBaseURL)
		}
	}
	client := factory(*todoistAPIKey)

	// Create the task request.
	taskRequest := &todoist.CreateTaskRequest{
		Content:     req.Subject,
		Description: req.Body,
	}

	// Add default project ID if specified.
	if projectID := *todoistDefaultProjectID; projectID != "" {
		taskRequest.ProjectID = projectID
	}

	// Use a deterministic request ID so retries do not create duplicate Todoist tasks.
	requestID := buildTodoistRequestID(req)

	// Create the task.
	task, err := client.CreateTask(ctx, requestID, taskRequest)
	if err != nil {
		return nil, fmt.Errorf("failed to create task in Todoist: %w", err)
	}

	message := fmt.Sprintf("Successfully created task: %s (ID: %s)", task.Content, task.ID)

	return &pb.TodoResponse{
		Id:      task.ID,
		Message: message,
	}, nil
}

func buildTodoistRequestID(req *pb.TodoRequest) string {
	hashInput := strings.Join([]string{
		req.GetSubject(),
		req.GetBody(),
		req.GetFrom(),
	}, "\x00")
	sum := sha256.Sum256([]byte(hashInput))
	hash := hex.EncodeToString(sum[:])
	return todoistRequestIDPrefix + hash[:todoistRequestIDHashSize]
}

func main() {
	initLogger()
	flag.Parse()

	if err := runGRPCServer(); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func runGRPCServer() error {
	lis, err := net.Listen("tcp", fmt.Sprintf(":%d", *port))
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}

	server := grpc.NewServer()
	todoSvc := &todoServer{}
	todoistSvc := &todoistServer{}
	dependencySvc := newDependencyServer()

	pb.RegisterTodoServiceServer(server, todoSvc)
	pb.RegisterTodoistServiceServer(server, todoistSvc)
	pb.RegisterDependencyServiceServer(server, dependencySvc)
	reflection.Register(server)

	healthServer := health.NewServer()
	healthpb.RegisterHealthServer(server, healthServer)
	healthServer.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)

	backgroundCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dependencySvc.StartBackgroundReconcile(backgroundCtx)

	log.Infof("Todo gRPC server is running on port %d", *port)
	if err := server.Serve(lis); err != nil {
		return fmt.Errorf("failed to serve: %w", err)
	}
	return nil
}
