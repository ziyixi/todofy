package main

import (
	"context"
	"sort"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	pb "github.com/ziyixi/protos/go/todofy"
	"github.com/ziyixi/todofy/dependency"
	"github.com/ziyixi/todofy/todo/internal/todoist"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type updateContentCall struct {
	taskID  string
	content string
}

type fakeDependencyTodoistClient struct {
	tasksByID            map[string]*todoist.Task
	order                []string
	updateCalls          int
	updateContentCalls   []updateContentCall
	listErr              error
	getTaskErr           error
	updateTaskLabelsErr  error
	updateTaskContentErr error
	ensureLabelsErr      error
	ensureLabelsResult   *todoist.EnsureLabelsResult
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
	if f.getTaskErr != nil {
		return nil, f.getTaskErr
	}
	task := f.tasksByID[taskID]
	if task == nil {
		return nil, assert.AnError
	}
	copied := *task
	copied.Labels = append([]string(nil), task.Labels...)
	return &copied, nil
}

func (f *fakeDependencyTodoistClient) ListActiveTasks(_ context.Context) ([]*todoist.Task, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
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
	if f.updateTaskLabelsErr != nil {
		return nil, f.updateTaskLabelsErr
	}
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
	if f.updateTaskContentErr != nil {
		return nil, f.updateTaskContentErr
	}
	task := f.tasksByID[taskID]
	if task == nil {
		return nil, assert.AnError
	}
	f.updateContentCalls = append(f.updateContentCalls, updateContentCall{
		taskID:  taskID,
		content: content,
	})
	task.Content = content
	copied := *task
	copied.Labels = append([]string(nil), task.Labels...)
	return &copied, nil
}

func (f *fakeDependencyTodoistClient) EnsureLabels(
	_ context.Context,
	labels []string,
) (*todoist.EnsureLabelsResult, error) {
	if f.ensureLabelsErr != nil {
		return nil, f.ensureLabelsErr
	}
	if f.ensureLabelsResult != nil {
		return f.ensureLabelsResult, nil
	}
	return &todoist.EnsureLabelsResult{
		ExistingLabels: append([]string(nil), labels...),
		Failures:       map[string]string{},
	}, nil
}

func (f *fakeDependencyTodoistClient) VerifyWebhook(_ []byte, _ string, _ string) bool {
	return true
}

func saveDependencyFlags() func() {
	origKey := *todoistAPIKey
	origExcluded := *dependencyBootstrapExcludedProjectIDs
	origGrace := *dependencyGracePeriod
	origInterval := *dependencyReconcileInterval
	origDebounce := *dependencyWebhookDebounce
	origScheduler := *dependencyEnableScheduler
	return func() {
		*todoistAPIKey = origKey
		*dependencyBootstrapExcludedProjectIDs = origExcluded
		*dependencyGracePeriod = origGrace
		*dependencyReconcileInterval = origInterval
		*dependencyWebhookDebounce = origDebounce
		*dependencyEnableScheduler = origScheduler
	}
}

func TestNewDependencyServer(t *testing.T) {
	defer saveDependencyFlags()()
	*dependencyBootstrapExcludedProjectIDs = "proj-a, proj-b"
	*dependencyGracePeriod = 5 * time.Minute
	*dependencyReconcileInterval = time.Minute
	*dependencyWebhookDebounce = 3 * time.Second
	*dependencyEnableScheduler = false

	server := newDependencyServer()
	require.NotNil(t, server)
	assert.Equal(t, 5*time.Minute, server.gracePeriod)
	assert.Equal(t, time.Minute, server.reconcileInterval)
	assert.Equal(t, 3*time.Second, server.webhookDebounce)
	assert.False(t, server.enableBackgroundReconcile)
	assert.NotNil(t, server.dirtySignal)
	_, hasProjA := server.metadataExcludedProjectIDs["proj-a"]
	assert.True(t, hasProjA)
}

func TestDependencyServerGetClient(t *testing.T) {
	defer saveDependencyFlags()()
	*todoistAPIKey = ""

	server := &dependencyServer{}
	client, err := server.getClient()
	require.Nil(t, client)
	require.Error(t, err)
	assert.Equal(t, codes.InvalidArgument, status.Code(err))
}

func TestDependencyServerReconcileIsIdempotentWithMinimalDiff(t *testing.T) {
	defer saveDependencyFlags()()
	*todoistAPIKey = testGenericAPIKey

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
	assert.Contains(t, taskA.Labels, dependency.LabelBlocked)

	_, updatedCountSecondRun, err := server.reconcile(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 0, updatedCountSecondRun)
	assert.Equal(t, 1, fakeClient.updateCalls)
}

func TestDependencyServerReconcileGraph(t *testing.T) {
	defer saveDependencyFlags()()
	*todoistAPIKey = testGenericAPIKey

	fakeClient := newFakeDependencyTodoistClient([]*todoist.Task{
		{ID: "task-a", Content: "Task A <k:a dep:b>", UpdatedAt: time.Now().Add(-time.Hour).Format(time.RFC3339)},
		{ID: "task-b", Content: "Task B <k:b>", UpdatedAt: time.Now().Add(-time.Hour).Format(time.RFC3339)},
	})
	server := &dependencyServer{
		newTodoistClient: func(string) todoistOperationalClient { return fakeClient },
		gracePeriod:      0,
	}

	resp, err := server.ReconcileGraph(context.Background(), &pb.ReconcileDependencyGraphRequest{})
	require.NoError(t, err)
	assert.Equal(t, int32(2), resp.GetTaskCount())
	assert.Equal(t, int32(1), resp.GetUpdatedTaskCount())
}

func TestDependencyServerAnalyzeAndQueryMethods(t *testing.T) {
	defer saveDependencyFlags()()
	*todoistAPIKey = testGenericAPIKey

	fakeClient := newFakeDependencyTodoistClient([]*todoist.Task{
		{ID: "task-a", Content: "Task A <k:a dep:missing>"},
		{ID: "task-b", Content: "Task B <k:b>"},
	})
	server := &dependencyServer{
		newTodoistClient: func(string) todoistOperationalClient { return fakeClient },
	}

	analyzeResp, err := server.AnalyzeGraph(context.Background(), &pb.AnalyzeDependencyGraphRequest{})
	require.NoError(t, err)
	assert.Equal(t, int32(2), analyzeResp.GetTaskCount())

	statusResp, err := server.GetTaskStatus(context.Background(), &pb.GetTaskDependencyStatusRequest{
		TaskKey: "a",
	})
	require.NoError(t, err)
	require.NotNil(t, statusResp.GetStatus())
	assert.Equal(t, "task-a", statusResp.GetStatus().GetTodoistTaskId())

	issuesResp, err := server.ListDependencyIssues(context.Background(), &pb.ListDependencyIssuesRequest{
		Type:    pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_BROKEN_REFERENCE,
		TaskKey: "a",
	})
	require.NoError(t, err)
	require.Len(t, issuesResp.GetIssues(), 1)
	assert.Equal(t, pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_BROKEN_REFERENCE, issuesResp.GetIssues()[0].GetType())
}

func TestDependencyServerGetTaskStatusErrors(t *testing.T) {
	defer saveDependencyFlags()()
	*todoistAPIKey = testGenericAPIKey

	server := &dependencyServer{
		newTodoistClient: func(string) todoistOperationalClient {
			return newFakeDependencyTodoistClient([]*todoist.Task{
				{ID: "task-a", Content: "Task A <k:a>"},
			})
		},
	}

	_, err := server.GetTaskStatus(context.Background(), &pb.GetTaskDependencyStatusRequest{})
	require.Error(t, err)
	assert.Equal(t, codes.InvalidArgument, status.Code(err))

	_, err = server.GetTaskStatus(context.Background(), &pb.GetTaskDependencyStatusRequest{TaskKey: "missing"})
	require.Error(t, err)
	assert.Equal(t, codes.NotFound, status.Code(err))
}

func TestDependencyServerMarkGraphDirty(t *testing.T) {
	server := &dependencyServer{
		dirtySignal: make(chan struct{}, 1),
	}
	server.dirtySignal <- struct{}{}

	resp, err := server.MarkGraphDirty(context.Background(), &pb.MarkDependencyGraphDirtyRequest{})
	require.NoError(t, err)
	assert.True(t, resp.GetAccepted())
	assert.Len(t, server.dirtySignal, 1)
}

func TestDependencyServerStartBackgroundReconcile(t *testing.T) {
	defer saveDependencyFlags()()
	*todoistAPIKey = testGenericAPIKey

	fakeClient := newFakeDependencyTodoistClient([]*todoist.Task{
		{ID: "task-a", Content: "Task A <k:a dep:b>", UpdatedAt: time.Now().Add(-time.Hour).Format(time.RFC3339)},
		{ID: "task-b", Content: "Task B <k:b>", UpdatedAt: time.Now().Add(-time.Hour).Format(time.RFC3339)},
	})
	server := &dependencyServer{
		newTodoistClient:          func(string) todoistOperationalClient { return fakeClient },
		gracePeriod:               0,
		enableBackgroundReconcile: true,
		webhookDebounce:           0,
		dirtySignal:               make(chan struct{}, 1),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server.StartBackgroundReconcile(ctx)

	_, err := server.MarkGraphDirty(context.Background(), &pb.MarkDependencyGraphDirtyRequest{})
	require.NoError(t, err)

	require.Eventually(t, func() bool {
		return fakeClient.updateCalls == 1
	}, 2*time.Second, 20*time.Millisecond)
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

func TestDependencyServerBootstrapMissingTaskKeysSkipsExcludedProjects(t *testing.T) {
	defer saveDependencyFlags()()
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

func TestDependencyServerBootstrapMissingTaskKeysUpdatesContentWhenNotDryRun(t *testing.T) {
	defer saveDependencyFlags()()
	*todoistAPIKey = testGenericAPIKey

	fakeClient := newFakeDependencyTodoistClient([]*todoist.Task{
		{ID: "task-a", Content: "Task A"},
	})
	server := &dependencyServer{
		newTodoistClient: func(string) todoistOperationalClient { return fakeClient },
	}

	resp, err := server.BootstrapMissingTaskKeys(context.Background(), &pb.BootstrapMissingTaskKeysRequest{
		DryRun: false,
	})
	require.NoError(t, err)
	require.Len(t, fakeClient.updateContentCalls, 1)
	assert.Equal(t, "task-a", fakeClient.updateContentCalls[0].taskID)
	assert.Contains(t, fakeClient.updateContentCalls[0].content, "<k:")
	assert.Equal(t, int32(1), resp.GetGeneratedCount())
}

func TestDependencyServerBootstrapMissingTaskKeysUpdateFailure(t *testing.T) {
	defer saveDependencyFlags()()
	*todoistAPIKey = testGenericAPIKey

	fakeClient := newFakeDependencyTodoistClient([]*todoist.Task{
		{ID: "task-a", Content: "Task A"},
	})
	fakeClient.updateTaskContentErr = assert.AnError

	server := &dependencyServer{
		newTodoistClient: func(string) todoistOperationalClient { return fakeClient },
	}

	resp, err := server.BootstrapMissingTaskKeys(context.Background(), &pb.BootstrapMissingTaskKeysRequest{
		DryRun: false,
	})
	require.Nil(t, resp)
	require.Error(t, err)
	assert.Equal(t, codes.Internal, status.Code(err))
}

func TestBuildDependencyReport(t *testing.T) {
	report := buildDependencyReport([]*todoist.Task{
		{
			ID:          "task-a",
			Content:     "Task A <k:a dep:b>",
			Labels:      []string{"existing"},
			CompletedAt: "2026-03-14T00:00:00Z",
		},
		{
			ID:      "task-b",
			Content: "Task B <k:b>",
		},
	})

	require.NotNil(t, report)
	assert.Equal(t, 2, report.TaskCount)
	require.Len(t, report.TaskStatuses, 2)
	assert.Equal(t, "Task A", report.TaskStatuses[0].GetTodoistTask().GetContent())
	assert.True(t, report.TaskStatuses[0].GetTodoistTask().GetCompleted())
}

func TestDesiredReservedLabelsFromTaskStatus(t *testing.T) {
	statusItem := &pb.TaskDependencyStatus{
		Readiness: pb.TaskReadinessState_TASK_READINESS_STATE_BLOCKED,
		Issues: []*pb.DependencyIssue{
			{Type: pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_PARSE_ERROR},
			nil,
			{Type: pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_BROKEN_REFERENCE},
			{Type: pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_CYCLE},
			{Type: pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_DUPLICATE_KEY},
		},
	}

	assert.Equal(t, []string{
		dependency.LabelBlocked,
		dependency.LabelBrokenDep,
		dependency.LabelCycle,
		dependency.LabelInvalidMeta,
	}, desiredReservedLabelsFromTaskStatus(statusItem))
	assert.Nil(t, desiredReservedLabelsFromTaskStatus(&pb.TaskDependencyStatus{
		Readiness: pb.TaskReadinessState_TASK_READINESS_STATE_COMPLETED,
	}))
}

func TestToProtoIssueAndReadiness(t *testing.T) {
	assert.Equal(t, pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_PARSE_ERROR, toProtoIssue(dependency.Issue{
		Kind: dependency.IssueKindParseError,
	}).GetType())
	assert.Equal(t, pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_INVALID_KEY, toProtoIssue(dependency.Issue{
		Kind: dependency.IssueKindInvalidKey,
	}).GetType())
	assert.Equal(t, pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_DUPLICATE_KEY, toProtoIssue(dependency.Issue{
		Kind: dependency.IssueKindDuplicateKey,
	}).GetType())
	assert.Equal(t, pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_BROKEN_REFERENCE, toProtoIssue(dependency.Issue{
		Kind: dependency.IssueKindBrokenReference,
	}).GetType())
	assert.Equal(t, pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_CYCLE, toProtoIssue(dependency.Issue{
		Kind: dependency.IssueKindCycle,
	}).GetType())
	assert.Equal(t, pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_UNSPECIFIED, toProtoIssue(dependency.Issue{}).GetType())

	assert.Equal(t, pb.TaskReadinessState_TASK_READINESS_STATE_READY, toProtoReadiness(dependency.ReadinessStateReady))
	assert.Equal(t, pb.TaskReadinessState_TASK_READINESS_STATE_BLOCKED, toProtoReadiness(dependency.ReadinessStateBlocked))
	assert.Equal(
		t,
		pb.TaskReadinessState_TASK_READINESS_STATE_COMPLETED,
		toProtoReadiness(dependency.ReadinessStateCompleted),
	)
	assert.Equal(t, pb.TaskReadinessState_TASK_READINESS_STATE_INVALID, toProtoReadiness(dependency.ReadinessStateInvalid))
	assert.Equal(
		t,
		pb.TaskReadinessState_TASK_READINESS_STATE_UNSPECIFIED,
		toProtoReadiness(dependency.ReadinessState("bogus")),
	)
}

func TestWithinGracePeriod(t *testing.T) {
	now := time.Now()

	assert.False(t, withinGracePeriod("", now, time.Minute))
	assert.False(t, withinGracePeriod("bogus", now, time.Minute))
	assert.False(t, withinGracePeriod(now.Add(time.Minute).Format(time.RFC3339), now, time.Minute))
	assert.False(t, withinGracePeriod(now.Add(-2*time.Minute).Format(time.RFC3339), now, time.Minute))
	assert.False(t, withinGracePeriod(now.Format(time.RFC3339), now, 0))
	assert.True(t, withinGracePeriod(now.Add(-30*time.Second).Format(time.RFC3339Nano), now, time.Minute))
}

func TestIsMetadataBootstrapExcludedProject(t *testing.T) {
	server := &dependencyServer{
		metadataExcludedProjectIDs: map[string]struct{}{
			"proj-a": {},
		},
	}

	assert.True(t, server.isMetadataBootstrapExcludedProject("proj-a"))
	assert.False(t, server.isMetadataBootstrapExcludedProject(""))
	assert.False(t, server.isMetadataBootstrapExcludedProject("proj-b"))
}
