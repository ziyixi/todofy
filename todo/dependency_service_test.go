package main

import (
	"context"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/ziyixi/todofy/todo/internal/todoist"
)

type fakeDependencyTodoistClient struct {
	tasksByID   map[string]*todoist.Task
	order       []string
	updateCalls int
}

func newFakeDependencyTodoistClient(tasks []*todoist.Task) *fakeDependencyTodoistClient {
	out := &fakeDependencyTodoistClient{
		tasksByID: make(map[string]*todoist.Task, len(tasks)),
		order:     make([]string, 0, len(tasks)),
	}
	for _, task := range tasks {
		if task == nil {
			continue
		}
		copied := *task
		copied.Labels = append([]string(nil), task.Labels...)
		out.tasksByID[copied.ID] = &copied
		out.order = append(out.order, copied.ID)
	}
	return out
}

func (f *fakeDependencyTodoistClient) GetTask(_ context.Context, taskID string) (*todoist.Task, error) {
	task := f.tasksByID[taskID]
	if task == nil {
		return nil, assert.AnError
	}
	copied := *task
	copied.Labels = append([]string(nil), task.Labels...)
	return &copied, nil
}

func (f *fakeDependencyTodoistClient) ListActiveTasks(_ context.Context) ([]*todoist.Task, error) {
	out := make([]*todoist.Task, 0, len(f.order))
	for _, id := range f.order {
		task := f.tasksByID[id]
		if task == nil {
			continue
		}
		copied := *task
		copied.Labels = append([]string(nil), task.Labels...)
		out = append(out, &copied)
	}
	return out, nil
}

func (f *fakeDependencyTodoistClient) UpdateTaskLabels(
	_ context.Context,
	taskID string,
	addLabels []string,
	removeLabels []string,
) (*todoist.Task, error) {
	task := f.tasksByID[taskID]
	if task == nil {
		return nil, assert.AnError
	}

	f.updateCalls++
	labelSet := make(map[string]struct{}, len(task.Labels))
	for _, label := range task.Labels {
		labelSet[label] = struct{}{}
	}
	for _, label := range addLabels {
		labelSet[label] = struct{}{}
	}
	for _, label := range removeLabels {
		delete(labelSet, label)
	}

	updated := make([]string, 0, len(labelSet))
	for label := range labelSet {
		updated = append(updated, label)
	}
	sort.Strings(updated)
	task.Labels = updated

	copied := *task
	copied.Labels = append([]string(nil), task.Labels...)
	return &copied, nil
}

func (f *fakeDependencyTodoistClient) UpdateTaskContent(
	_ context.Context,
	taskID string,
	content string,
) (*todoist.Task, error) {
	task := f.tasksByID[taskID]
	if task == nil {
		return nil, assert.AnError
	}
	task.Content = content
	copied := *task
	copied.Labels = append([]string(nil), task.Labels...)
	return &copied, nil
}

func (f *fakeDependencyTodoistClient) EnsureLabels(
	_ context.Context,
	labels []string,
) (*todoist.EnsureLabelsResult, error) {
	return &todoist.EnsureLabelsResult{
		ExistingLabels: append([]string(nil), labels...),
		Failures:       map[string]string{},
	}, nil
}

func (f *fakeDependencyTodoistClient) VerifyWebhook(_ []byte, _ string, _ string) bool {
	return true
}

func TestDependencyServer_ReconcileIsIdempotentWithMinimalDiff(t *testing.T) {
	originalKey := *todoistAPIKey
	t.Cleanup(func() {
		*todoistAPIKey = originalKey
	})
	*todoistAPIKey = "test-key"

	oldUpdateTime := time.Now().Add(-10 * time.Minute).Format(time.RFC3339)
	fakeClient := newFakeDependencyTodoistClient([]*todoist.Task{
		{
			ID:        "task-a",
			Content:   "Task A <k:a dep:b>",
			Labels:    nil,
			UpdatedAt: oldUpdateTime,
		},
		{
			ID:        "task-b",
			Content:   "Task B <k:b>",
			Labels:    nil,
			UpdatedAt: oldUpdateTime,
		},
	})

	server := &dependencyServer{
		newTodoistClient: func(string) todoistOperationalClient {
			return fakeClient
		},
		gracePeriod: 0,
	}

	report, updatedCount, err := server.reconcile(context.Background())
	require.NoError(t, err)
	require.NotNil(t, report)
	assert.Equal(t, 1, updatedCount)

	taskA := fakeClient.tasksByID["task-a"]
	require.NotNil(t, taskA)
	assert.True(t, strings.Contains(strings.Join(taskA.Labels, ","), "dag_blocked"))

	_, updatedCountSecondRun, err := server.reconcile(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 0, updatedCountSecondRun)
	assert.Equal(t, 1, fakeClient.updateCalls)
}
