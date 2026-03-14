package main

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	pb "github.com/ziyixi/protos/go/todofy"
	"github.com/ziyixi/todofy/todo/internal/todoist"
)

type mockTodoistTaskCreator struct{ mock.Mock }

func (m *mockTodoistTaskCreator) CreateTask(
	ctx context.Context,
	requestID string,
	taskDetails *todoist.CreateTaskRequest,
) (*todoist.Task, error) {
	args := m.Called(ctx, requestID, taskDetails)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*todoist.Task), args.Error(1)
}

const testGenericAPIKey = "test-key"

func TestTodoServer_PopulateTodo_StrictTodoistOnly(t *testing.T) {
	t.Run("rejects non-todoist app", func(t *testing.T) {
		server := &todoServer{}

		req := &pb.TodoRequest{
			App:     pb.TodoApp_TODO_APP_DIDA365,
			Method:  pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET,
			Subject: "Test Todo",
			Body:    "Test Body",
		}

		resp, err := server.PopulateTodo(context.Background(), req)

		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "unsupported app")
	})

	t.Run("rejects non-todoist method", func(t *testing.T) {
		server := &todoServer{}

		req := &pb.TodoRequest{
			App:     pb.TodoApp_TODO_APP_TODOIST,
			Method:  pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_API,
			Subject: "Test Todo",
			Body:    "Test Body",
		}

		resp, err := server.PopulateTodo(context.Background(), req)

		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "unsupported method")
	})

	t.Run("accepts todoist app and method, then executes todoist path", func(t *testing.T) {
		server := &todoServer{}

		originalKey := *todoistAPIKey
		defer func() { *todoistAPIKey = originalKey }()
		*todoistAPIKey = ""

		req := &pb.TodoRequest{
			App:     pb.TodoApp_TODO_APP_TODOIST,
			Method:  pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_TODOIST,
			Subject: "Test Todo",
			Body:    "Test Body",
		}

		resp, err := server.PopulateTodo(context.Background(), req)

		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "missing todoist API key")
		assert.NotContains(t, err.Error(), "unsupported")
	})
}

func TestValidateTodoistFlags(t *testing.T) {
	t.Run("fails with missing API key", func(t *testing.T) {
		originalKey := *todoistAPIKey
		defer func() { *todoistAPIKey = originalKey }()

		*todoistAPIKey = ""

		err := validateTodoistFlags()
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "missing todoist API key")
	})

	t.Run("succeeds with valid configuration", func(t *testing.T) {
		originalKey := *todoistAPIKey
		defer func() { *todoistAPIKey = originalKey }()

		*todoistAPIKey = testGenericAPIKey

		err := validateTodoistFlags()
		assert.NoError(t, err)
	})
}

func TestPopulateTodoByTodoist_DI(t *testing.T) {
	saveTodoistFlags := func() func() {
		origKey := *todoistAPIKey
		origDefaultProject := *todoistDefaultProjectID
		return func() {
			*todoistAPIKey = origKey
			*todoistDefaultProjectID = origDefaultProject
		}
	}

	t.Run("success", func(t *testing.T) {
		defer saveTodoistFlags()()
		*todoistAPIKey = testGenericAPIKey
		*todoistDefaultProjectID = ""

		mockCreator := new(mockTodoistTaskCreator)
		mockCreator.On("CreateTask", mock.Anything, mock.Anything, mock.MatchedBy(func(req *todoist.CreateTaskRequest) bool {
			return req.Content == "Test Todo" && req.Description == "Test Body" && req.ProjectID == ""
		})).Return(&todoist.Task{
			ID:      "task-123",
			Content: "Test Todo",
		}, nil)

		server := &todoServer{
			newTodoistClient: func(apiKey string) todoistTaskCreator {
				assert.Equal(t, testGenericAPIKey, apiKey)
				return mockCreator
			},
		}

		req := &pb.TodoRequest{
			App:     pb.TodoApp_TODO_APP_TODOIST,
			Method:  pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_TODOIST,
			Subject: "Test Todo",
			Body:    "Test Body",
		}

		resp, err := server.PopulateTodoByTodoist(context.Background(), req)
		assert.NoError(t, err)
		assert.NotNil(t, resp)
		assert.Equal(t, "task-123", resp.Id)
		assert.Contains(t, resp.Message, "task-123")
		mockCreator.AssertExpectations(t)
	})

	t.Run("create error", func(t *testing.T) {
		defer saveTodoistFlags()()
		*todoistAPIKey = testGenericAPIKey

		mockCreator := new(mockTodoistTaskCreator)
		mockCreator.On("CreateTask", mock.Anything, mock.Anything, mock.Anything).Return(nil, assert.AnError)

		server := &todoServer{
			newTodoistClient: func(apiKey string) todoistTaskCreator {
				return mockCreator
			},
		}

		req := &pb.TodoRequest{
			Subject: "Test Todo",
			Body:    "Test Body",
		}

		resp, err := server.PopulateTodoByTodoist(context.Background(), req)
		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "failed to create task in Todoist")
		mockCreator.AssertExpectations(t)
	})

	t.Run("adds project id when configured", func(t *testing.T) {
		defer saveTodoistFlags()()
		*todoistAPIKey = testGenericAPIKey
		*todoistDefaultProjectID = "proj-456"

		mockCreator := new(mockTodoistTaskCreator)
		mockCreator.On("CreateTask", mock.Anything, mock.Anything,
			mock.MatchedBy(func(req *todoist.CreateTaskRequest) bool {
				return req.ProjectID == "proj-456"
			}),
		).Return(&todoist.Task{
			ID:      "task-456",
			Content: "Project task",
		}, nil)

		server := &todoServer{
			newTodoistClient: func(apiKey string) todoistTaskCreator {
				return mockCreator
			},
		}

		req := &pb.TodoRequest{
			Subject: "Project task",
			Body:    "Body",
		}

		resp, err := server.PopulateTodoByTodoist(context.Background(), req)
		assert.NoError(t, err)
		assert.NotNil(t, resp)
		assert.Equal(t, "task-456", resp.Id)
		mockCreator.AssertExpectations(t)
	})
}
