package main

import (
	"context"
	"fmt"
	"sort"
	"strings"

	pb "github.com/ziyixi/protos/go/todofy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type todoistServer struct {
	pb.UnimplementedTodoistServiceServer
	// newTodoistClient is injectable for tests.
	newTodoistClient todoistOperationalClientFactory
}

func (s *todoistServer) getClient() (todoistOperationalClient, error) {
	if err := validateTodoistFlags(); err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "%v", err)
	}
	factory := s.newTodoistClient
	if factory == nil {
		factory = defaultTodoistOperationalClientFactory
	}
	return factory(*todoistAPIKey), nil
}

// GetTask fetches one Todoist task and returns a normalized task payload.
func (s *todoistServer) GetTask(
	ctx context.Context,
	req *pb.GetTodoistTaskRequest,
) (*pb.GetTodoistTaskResponse, error) {
	taskID := strings.TrimSpace(req.GetTodoistTaskId())
	if taskID == "" {
		return nil, status.Error(codes.InvalidArgument, "todoist_task_id is required")
	}

	client, err := s.getClient()
	if err != nil {
		return nil, err
	}

	task, err := client.GetTask(ctx, taskID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get Todoist task: %v", err)
	}

	return &pb.GetTodoistTaskResponse{
		Task: normalizedTaskFromTodoistTask(task),
	}, nil
}

// ListActiveTasks returns active Todoist tasks normalized for downstream dependency logic.
func (s *todoistServer) ListActiveTasks(
	ctx context.Context,
	_ *pb.ListActiveTodoistTasksRequest,
) (*pb.ListActiveTodoistTasksResponse, error) {
	client, err := s.getClient()
	if err != nil {
		return nil, err
	}

	tasks, err := client.ListActiveTasks(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to list active Todoist tasks: %v", err)
	}

	out := make([]*pb.NormalizedTodoistTask, 0, len(tasks))
	for _, task := range tasks {
		out = append(out, normalizedTaskFromTodoistTask(task))
	}

	return &pb.ListActiveTodoistTasksResponse{Tasks: out}, nil
}

// UpdateTaskLabels applies add/remove label operations to one Todoist task.
func (s *todoistServer) UpdateTaskLabels(
	ctx context.Context,
	req *pb.UpdateTodoistTaskLabelsRequest,
) (*pb.UpdateTodoistTaskLabelsResponse, error) {
	taskID := strings.TrimSpace(req.GetTodoistTaskId())
	if taskID == "" {
		return nil, status.Error(codes.InvalidArgument, "todoist_task_id is required")
	}

	client, err := s.getClient()
	if err != nil {
		return nil, err
	}

	task, err := client.UpdateTaskLabels(ctx, taskID, req.GetAddLabels(), req.GetRemoveLabels())
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to update Todoist task labels: %v", err)
	}

	return &pb.UpdateTodoistTaskLabelsResponse{
		Task: normalizedTaskFromTodoistTask(task),
	}, nil
}

// EnsureLabels guarantees the requested Todoist labels exist and reports partial failures.
func (s *todoistServer) EnsureLabels(
	ctx context.Context,
	req *pb.EnsureTodoistLabelsRequest,
) (*pb.EnsureTodoistLabelsResponse, error) {
	client, err := s.getClient()
	if err != nil {
		return nil, err
	}

	result, err := client.EnsureLabels(ctx, req.GetLabels())
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to ensure Todoist labels: %v", err)
	}

	failures := make([]*pb.EnsureTodoistLabelFailure, 0, len(result.Failures))
	failureLabels := make([]string, 0, len(result.Failures))
	for label := range result.Failures {
		failureLabels = append(failureLabels, label)
	}
	sort.Strings(failureLabels)
	for _, label := range failureLabels {
		failures = append(failures, &pb.EnsureTodoistLabelFailure{
			Label:  label,
			Reason: result.Failures[label],
		})
	}

	resp := &pb.EnsureTodoistLabelsResponse{
		ExistingLabels: append([]string(nil), result.ExistingLabels...),
		CreatedLabels:  append([]string(nil), result.CreatedLabels...),
		Failures:       failures,
	}

	if len(resp.Failures) > 0 {
		log.Warningf("todoist ensure labels returned partial failures: %v", fmtFailures(resp.Failures))
	}
	return resp, nil
}

// fmtFailures converts label failure details into compact log text.
func fmtFailures(failures []*pb.EnsureTodoistLabelFailure) string {
	parts := make([]string, 0, len(failures))
	for _, failure := range failures {
		if failure == nil {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s=%s", failure.GetLabel(), failure.GetReason()))
	}
	return strings.Join(parts, ", ")
}
