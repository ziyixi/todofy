package main

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	pb "github.com/ziyixi/protos/go/todofy"
	"github.com/ziyixi/todofy/todo/internal/todoist"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const testTodoistWebhookSecret = "secret"

type fakeTodoistOperationalClient struct {
	getTaskFunc           func(context.Context, string) (*todoist.Task, error)
	listActiveTasksFunc   func(context.Context) ([]*todoist.Task, error)
	updateTaskLabelsFunc  func(context.Context, string, []string, []string) (*todoist.Task, error)
	updateTaskContentFunc func(context.Context, string, string) (*todoist.Task, error)
	ensureLabelsFunc      func(context.Context, []string) (*todoist.EnsureLabelsResult, error)
	verifyWebhookFunc     func([]byte, string, string) bool
}

func (f *fakeTodoistOperationalClient) GetTask(ctx context.Context, taskID string) (*todoist.Task, error) {
	if f.getTaskFunc == nil {
		return nil, nil
	}
	return f.getTaskFunc(ctx, taskID)
}

func (f *fakeTodoistOperationalClient) ListActiveTasks(ctx context.Context) ([]*todoist.Task, error) {
	if f.listActiveTasksFunc == nil {
		return nil, nil
	}
	return f.listActiveTasksFunc(ctx)
}

func (f *fakeTodoistOperationalClient) UpdateTaskLabels(
	ctx context.Context,
	taskID string,
	addLabels []string,
	removeLabels []string,
) (*todoist.Task, error) {
	if f.updateTaskLabelsFunc == nil {
		return nil, nil
	}
	return f.updateTaskLabelsFunc(ctx, taskID, addLabels, removeLabels)
}

func (f *fakeTodoistOperationalClient) UpdateTaskContent(
	ctx context.Context,
	taskID string,
	content string,
) (*todoist.Task, error) {
	if f.updateTaskContentFunc == nil {
		return nil, nil
	}
	return f.updateTaskContentFunc(ctx, taskID, content)
}

func (f *fakeTodoistOperationalClient) EnsureLabels(
	ctx context.Context,
	labels []string,
) (*todoist.EnsureLabelsResult, error) {
	if f.ensureLabelsFunc == nil {
		return nil, nil
	}
	return f.ensureLabelsFunc(ctx, labels)
}

func (f *fakeTodoistOperationalClient) VerifyWebhook(rawBody []byte, signature string, secret string) bool {
	if f.verifyWebhookFunc == nil {
		return false
	}
	return f.verifyWebhookFunc(rawBody, signature, secret)
}

func saveTodoistServiceFlags() func() {
	origKey := *todoistAPIKey
	origSecret := *todoistWebhookSecret
	return func() {
		*todoistAPIKey = origKey
		*todoistWebhookSecret = origSecret
	}
}

func TestTodoistServerGetClient(t *testing.T) {
	defer saveTodoistServiceFlags()()
	*todoistAPIKey = ""

	server := &todoistServer{}
	client, err := server.getClient()
	require.Nil(t, client)
	require.Error(t, err)
	assert.Equal(t, codes.InvalidArgument, status.Code(err))
	assert.Contains(t, err.Error(), "missing todoist API key")
}

func TestTodoistServerGetTask(t *testing.T) {
	t.Run("requires task id", func(t *testing.T) {
		server := &todoistServer{}
		resp, err := server.GetTask(context.Background(), &pb.GetTodoistTaskRequest{})
		require.Nil(t, resp)
		require.Error(t, err)
		assert.Equal(t, codes.InvalidArgument, status.Code(err))
	})

	t.Run("returns normalized task", func(t *testing.T) {
		defer saveTodoistServiceFlags()()
		*todoistAPIKey = testGenericAPIKey

		server := &todoistServer{
			newTodoistClient: func(apiKey string) todoistOperationalClient {
				assert.Equal(t, testGenericAPIKey, apiKey)
				return &fakeTodoistOperationalClient{
					getTaskFunc: func(_ context.Context, taskID string) (*todoist.Task, error) {
						assert.Equal(t, "task-1", taskID)
						return &todoist.Task{
							ID:        "task-1",
							Content:   "Task A <k:alpha dep:beta>",
							Labels:    []string{"dag_blocked"},
							Checked:   true,
							UpdatedAt: "2026-03-14T00:00:00Z",
						}, nil
					},
				}
			},
		}

		resp, err := server.GetTask(context.Background(), &pb.GetTodoistTaskRequest{TodoistTaskId: "task-1"})
		require.NoError(t, err)
		require.NotNil(t, resp)
		require.NotNil(t, resp.GetTask())
		assert.Equal(t, "Task A", resp.GetTask().GetContent())
		assert.Equal(t, "alpha", resp.GetTask().GetMetadata().GetTaskKey())
		assert.Equal(t, []string{"beta"}, resp.GetTask().GetMetadata().GetDependencyKeys())
		assert.True(t, resp.GetTask().GetCompleted())
	})

	t.Run("wraps client errors", func(t *testing.T) {
		defer saveTodoistServiceFlags()()
		*todoistAPIKey = testGenericAPIKey

		server := &todoistServer{
			newTodoistClient: func(string) todoistOperationalClient {
				return &fakeTodoistOperationalClient{
					getTaskFunc: func(context.Context, string) (*todoist.Task, error) {
						return nil, assert.AnError
					},
				}
			},
		}

		resp, err := server.GetTask(context.Background(), &pb.GetTodoistTaskRequest{TodoistTaskId: "task-1"})
		require.Nil(t, resp)
		require.Error(t, err)
		assert.Equal(t, codes.Internal, status.Code(err))
		assert.Contains(t, err.Error(), "failed to get Todoist task")
	})
}

func TestTodoistServerListActiveTasks(t *testing.T) {
	defer saveTodoistServiceFlags()()
	*todoistAPIKey = testGenericAPIKey

	server := &todoistServer{
		newTodoistClient: func(string) todoistOperationalClient {
			return &fakeTodoistOperationalClient{
				listActiveTasksFunc: func(context.Context) ([]*todoist.Task, error) {
					return []*todoist.Task{
						{
							ID:      "task-1",
							Content: "Task One <k:one>",
						},
						{
							ID:          "task-2",
							Content:     "Task Two <k:two>",
							CompletedAt: "2026-03-14T01:00:00Z",
						},
					}, nil
				},
			}
		},
	}

	resp, err := server.ListActiveTasks(context.Background(), &pb.ListActiveTodoistTasksRequest{})
	require.NoError(t, err)
	require.Len(t, resp.GetTasks(), 2)
	assert.False(t, resp.GetTasks()[0].GetCompleted())
	assert.True(t, resp.GetTasks()[1].GetCompleted())
	assert.Equal(t, "Task Two", resp.GetTasks()[1].GetContent())
}

func TestTodoistServerUpdateTaskLabels(t *testing.T) {
	t.Run("requires task id", func(t *testing.T) {
		server := &todoistServer{}
		resp, err := server.UpdateTaskLabels(context.Background(), &pb.UpdateTodoistTaskLabelsRequest{})
		require.Nil(t, resp)
		require.Error(t, err)
		assert.Equal(t, codes.InvalidArgument, status.Code(err))
	})

	t.Run("updates labels", func(t *testing.T) {
		defer saveTodoistServiceFlags()()
		*todoistAPIKey = testGenericAPIKey

		server := &todoistServer{
			newTodoistClient: func(string) todoistOperationalClient {
				return &fakeTodoistOperationalClient{
					updateTaskLabelsFunc: func(
						_ context.Context,
						taskID string,
						addLabels []string,
						removeLabels []string,
					) (*todoist.Task, error) {
						assert.Equal(t, "task-1", taskID)
						assert.Equal(t, []string{"dag_blocked"}, addLabels)
						assert.Equal(t, []string{"old"}, removeLabels)
						return &todoist.Task{
							ID:      "task-1",
							Content: "Task A <k:alpha>",
							Labels:  []string{"dag_blocked"},
						}, nil
					},
				}
			},
		}

		resp, err := server.UpdateTaskLabels(context.Background(), &pb.UpdateTodoistTaskLabelsRequest{
			TodoistTaskId: "task-1",
			AddLabels:     []string{"dag_blocked"},
			RemoveLabels:  []string{"old"},
		})
		require.NoError(t, err)
		require.NotNil(t, resp)
		assert.Equal(t, []string{"dag_blocked"}, resp.GetTask().GetLabels())
	})
}

func TestTodoistServerVerifyWebhook(t *testing.T) {
	t.Run("missing secret", func(t *testing.T) {
		defer saveTodoistServiceFlags()()
		*todoistWebhookSecret = ""

		server := &todoistServer{}
		resp, err := server.VerifyWebhook(context.Background(), &pb.VerifyTodoistWebhookRequest{})
		require.NoError(t, err)
		assert.False(t, resp.GetValid())
		assert.Equal(t, "missing_secret", resp.GetReason())
	})

	t.Run("missing signature", func(t *testing.T) {
		defer saveTodoistServiceFlags()()
		*todoistWebhookSecret = testTodoistWebhookSecret

		server := &todoistServer{}
		resp, err := server.VerifyWebhook(context.Background(), &pb.VerifyTodoistWebhookRequest{})
		require.NoError(t, err)
		assert.False(t, resp.GetValid())
		assert.Equal(t, "missing_signature", resp.GetReason())
	})

	t.Run("header fallback is case insensitive", func(t *testing.T) {
		defer saveTodoistServiceFlags()()
		*todoistWebhookSecret = testTodoistWebhookSecret

		server := &todoistServer{
			newTodoistClient: func(string) todoistOperationalClient {
				return &fakeTodoistOperationalClient{
					verifyWebhookFunc: func(rawBody []byte, signature string, secret string) bool {
						assert.Equal(t, []byte("body"), rawBody)
						assert.Equal(t, "sig", signature)
						assert.Equal(t, testTodoistWebhookSecret, secret)
						return true
					},
				}
			},
		}

		resp, err := server.VerifyWebhook(context.Background(), &pb.VerifyTodoistWebhookRequest{
			RawBody: []byte("body"),
			Headers: []*pb.TodoistWebhookHeader{
				{Key: "x-todoist-hmac-sha256", Value: "sig"},
			},
		})
		require.NoError(t, err)
		assert.True(t, resp.GetValid())
		assert.Equal(t, "ok", resp.GetReason())
	})

	t.Run("invalid signature", func(t *testing.T) {
		defer saveTodoistServiceFlags()()
		*todoistWebhookSecret = testTodoistWebhookSecret

		server := &todoistServer{
			newTodoistClient: func(string) todoistOperationalClient {
				return &fakeTodoistOperationalClient{
					verifyWebhookFunc: func([]byte, string, string) bool {
						return false
					},
				}
			},
		}

		resp, err := server.VerifyWebhook(context.Background(), &pb.VerifyTodoistWebhookRequest{
			RawBody:   []byte("body"),
			Signature: "sig",
			Headers:   []*pb.TodoistWebhookHeader{{Key: "ignored", Value: "ignored"}},
		})
		require.NoError(t, err)
		assert.False(t, resp.GetValid())
		assert.Equal(t, "invalid_signature", resp.GetReason())
	})
}

func TestTodoistServerEnsureLabels(t *testing.T) {
	t.Run("sorts failures", func(t *testing.T) {
		defer saveTodoistServiceFlags()()
		*todoistAPIKey = testGenericAPIKey

		server := &todoistServer{
			newTodoistClient: func(string) todoistOperationalClient {
				return &fakeTodoistOperationalClient{
					ensureLabelsFunc: func(_ context.Context, labels []string) (*todoist.EnsureLabelsResult, error) {
						assert.Equal(t, []string{"a", "b"}, labels)
						return &todoist.EnsureLabelsResult{
							ExistingLabels: []string{"b"},
							CreatedLabels:  []string{"a"},
							Failures: map[string]string{
								"zeta":  "already exists",
								"alpha": "conflict",
							},
						}, nil
					},
				}
			},
		}

		resp, err := server.EnsureLabels(context.Background(), &pb.EnsureTodoistLabelsRequest{
			Labels: []string{"a", "b"},
		})
		require.NoError(t, err)
		require.Len(t, resp.GetFailures(), 2)
		assert.Equal(t, "alpha", resp.GetFailures()[0].GetLabel())
		assert.Equal(t, "zeta", resp.GetFailures()[1].GetLabel())
	})

	t.Run("wraps ensure errors", func(t *testing.T) {
		defer saveTodoistServiceFlags()()
		*todoistAPIKey = testGenericAPIKey

		server := &todoistServer{
			newTodoistClient: func(string) todoistOperationalClient {
				return &fakeTodoistOperationalClient{
					ensureLabelsFunc: func(context.Context, []string) (*todoist.EnsureLabelsResult, error) {
						return nil, assert.AnError
					},
				}
			},
		}

		resp, err := server.EnsureLabels(context.Background(), &pb.EnsureTodoistLabelsRequest{
			Labels: []string{"a"},
		})
		require.Nil(t, resp)
		require.Error(t, err)
		assert.Equal(t, codes.Internal, status.Code(err))
		assert.Contains(t, err.Error(), "failed to ensure Todoist labels")
	})
}

func TestFmtFailures(t *testing.T) {
	assert.Equal(t, "alpha=conflict, beta=missing", fmtFailures([]*pb.EnsureTodoistLabelFailure{
		{Label: "alpha", Reason: "conflict"},
		nil,
		{Label: "beta", Reason: "missing"},
	}))
}
