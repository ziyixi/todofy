package main

import (
	"context"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	pb "github.com/ziyixi/protos/go/todofy"
	"github.com/ziyixi/todofy/dependency"
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

func TestMetadataBootstrapExcludedProjectSet(t *testing.T) {
	out := metadataBootstrapExcludedProjectSet("proj-a, proj-b,proj-a")
	require.Len(t, out, 2)
	_, hasA := out["proj-a"]
	_, hasB := out["proj-b"]
	assert.True(t, hasA)
	assert.True(t, hasB)

	assert.Nil(t, metadataBootstrapExcludedProjectSet(" , "))
}

func TestDependencyServer_BootstrapMissingTaskKeys_SkipsExcludedProjects(t *testing.T) {
	originalKey := *todoistAPIKey
	originalExcluded := *dependencyBootstrapExcludedProjectIDs
	t.Cleanup(func() {
		*todoistAPIKey = originalKey
		*dependencyBootstrapExcludedProjectIDs = originalExcluded
	})

	*todoistAPIKey = testGenericAPIKey
	*dependencyBootstrapExcludedProjectIDs = "proj-inbox, proj-skip-a, proj-skip-b"

	fakeClient := newFakeDependencyTodoistClient([]*todoist.Task{
		{ID: "inbox-task", Content: "Inbox Task", ProjectID: "proj-inbox"},
		{ID: "skip-task", Content: "Skip Task", ProjectID: "proj-skip-a"},
		{ID: "keep-task", Content: "Keep Task", ProjectID: "proj-keep"},
		{ID: "existing-task", Content: "Existing <k:existing>", ProjectID: "proj-keep"},
	})

	server := &dependencyServer{
		newTodoistClient: func(string) todoistOperationalClient {
			return fakeClient
		},
		metadataExcludedProjectIDs: metadataBootstrapExcludedProjectSet(*dependencyBootstrapExcludedProjectIDs),
	}

	resp, err := server.BootstrapMissingTaskKeys(context.Background(), &pb.BootstrapMissingTaskKeysRequest{})
	require.NoError(t, err)
	require.NotNil(t, resp)
	require.Len(t, resp.GeneratedTaskKeys, 1)
	assert.Equal(t, int32(1), resp.GetGeneratedCount())
	assert.Equal(t, "keep-task", resp.GeneratedTaskKeys[0].GetTodoistTaskId())

	inboxMeta := dependency.ParseTaskMetadata(fakeClient.tasksByID["inbox-task"].Content)
	assert.True(t, inboxMeta.Valid)
	assert.Empty(t, inboxMeta.TaskKey)

	skipMeta := dependency.ParseTaskMetadata(fakeClient.tasksByID["skip-task"].Content)
	assert.True(t, skipMeta.Valid)
	assert.Empty(t, skipMeta.TaskKey)

	keepMeta := dependency.ParseTaskMetadata(fakeClient.tasksByID["keep-task"].Content)
	assert.True(t, keepMeta.Valid)
	assert.NotEmpty(t, keepMeta.TaskKey)
	assert.Equal(t, resp.GeneratedTaskKeys[0].GetTaskKey(), keepMeta.TaskKey)

	existingMeta := dependency.ParseTaskMetadata(fakeClient.tasksByID["existing-task"].Content)
	assert.True(t, existingMeta.Valid)
	assert.Equal(t, "existing", existingMeta.TaskKey)
}
