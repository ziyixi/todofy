package main

import (
	"context"
	"strings"

	pb "github.com/ziyixi/protos/go/todofy"
	"github.com/ziyixi/todofy/dependency"
	"github.com/ziyixi/todofy/todo/internal/todoist"
)

// todoistOperationalClient is the subset of Todoist operations required by gRPC services.
type todoistOperationalClient interface {
	GetTask(ctx context.Context, taskID string) (*todoist.Task, error)
	ListActiveTasks(ctx context.Context) ([]*todoist.Task, error)
	UpdateTaskLabels(ctx context.Context, taskID string, addLabels []string, removeLabels []string) (*todoist.Task, error)
	UpdateTaskContent(ctx context.Context, taskID string, content string) (*todoist.Task, error)
	EnsureLabels(ctx context.Context, labels []string) (*todoist.EnsureLabelsResult, error)
	VerifyWebhook(rawBody []byte, signature string, secret string) bool
}

// todoistOperationalClientFactory creates a Todoist client from an API key.
type todoistOperationalClientFactory func(apiKey string) todoistOperationalClient

func defaultTodoistOperationalClientFactory(apiKey string) todoistOperationalClient {
	return todoist.NewClient(apiKey)
}

// normalizedTaskFromTodoistTask strips metadata syntax and returns API-facing task fields.
func normalizedTaskFromTodoistTask(task *todoist.Task) *pb.NormalizedTodoistTask {
	if task == nil {
		return nil
	}

	parsed := dependency.ParseTaskMetadata(task.Content)
	labels := append([]string(nil), task.Labels...)
	return &pb.NormalizedTodoistTask{
		TodoistTaskId: task.ID,
		Content:       parsed.DisplayTitle,
		Completed:     isTodoistTaskCompleted(task),
		Labels:        labels,
		Metadata: &pb.ParsedDependencyMetadata{
			TaskKey:        parsed.TaskKey,
			DependencyKeys: append([]string(nil), parsed.DependencyKeys...),
			Valid:          parsed.Valid,
			ParseError:     parsed.ParseError,
		},
	}
}

// isTodoistTaskCompleted normalizes completion checks across Todoist response variants.
func isTodoistTaskCompleted(task *todoist.Task) bool {
	if task == nil {
		return false
	}
	return task.Checked || task.IsCompleted || strings.TrimSpace(task.CompletedAt) != ""
}

// lookupTodoistHeader performs case-insensitive header lookup on proto header pairs.
func lookupTodoistHeader(headers []*pb.TodoistWebhookHeader, key string) string {
	for _, header := range headers {
		if header == nil {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(header.GetKey()), key) {
			return strings.TrimSpace(header.GetValue())
		}
	}
	return ""
}
