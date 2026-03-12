package main

import (
	"context"
	"flag"
	"fmt"
	"time"

	"github.com/sirupsen/logrus"
	"github.com/ziyixi/todofy/utils"
	"google.golang.org/grpc/codes"
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
	todoistAPIKey    = flag.String("todoist-api-key", "", "The API key for Todoist")
	todoistProjectID = flag.String("todoist-project-id", "", "The project ID for Todoist tasks")
)

// todoistTaskCreator abstracts the Todoist task creation API for testing.
type todoistTaskCreator interface {
	CreateTask(ctx context.Context, requestID string, taskDetails *todoist.CreateTaskRequest) (*todoist.Task, error)
}

type todoServer struct {
	pb.TodoServiceServer
	newTodoistClient func(apiKey string) todoistTaskCreator
}

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

func (s *todoServer) PopulateTodoByTodoist(ctx context.Context, req *pb.TodoRequest) (*pb.TodoResponse, error) {
	if err := validateTodoistFlags(); err != nil {
		return nil, err
	}

	factory := s.newTodoistClient
	if factory == nil {
		factory = func(apiKey string) todoistTaskCreator {
			return todoist.NewClient(apiKey)
		}
	}
	client := factory(*todoistAPIKey)

	// Create the task request.
	taskRequest := &todoist.CreateTaskRequest{
		Content:     req.Subject,
		Description: req.Body,
	}

	// Add project ID if specified.
	if *todoistProjectID != "" {
		taskRequest.ProjectID = *todoistProjectID
	}

	// Generate a request ID for idempotency (optional).
	requestID := fmt.Sprintf("todofy-%d", time.Now().Unix())

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

func main() {
	initLogger()
	flag.Parse()

	err := utils.StartGRPCServer[pb.TodoServiceServer](
		*port,
		&todoServer{},
		pb.RegisterTodoServiceServer,
	)
	if err != nil {
		log.Fatalf("server error: %v", err)
	}
}
