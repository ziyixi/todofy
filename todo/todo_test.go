package main

import (
	"context"
	"testing"

	"github.com/jomei/notionapi"
	mailjet "github.com/mailjet/mailjet-apiv3-go/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	pb "github.com/ziyixi/protos/go/todofy"
	"github.com/ziyixi/todofy/todo/internal/todoist"
)

// --- Mock types for DI-based tests ---

type mockMailjetSender struct{ mock.Mock }

func (m *mockMailjetSender) SendMailV31(data *mailjet.MessagesV31, options ...mailjet.RequestOptions) (*mailjet.ResultsV31, error) {
	args := m.Called(data, options)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*mailjet.ResultsV31), args.Error(1)
}

type mockNotionPageCreator struct{ mock.Mock }

func (m *mockNotionPageCreator) Create(ctx context.Context, requestBody *notionapi.PageCreateRequest) (*notionapi.Page, error) {
	args := m.Called(ctx, requestBody)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*notionapi.Page), args.Error(1)
}

type mockTodoistTaskCreator struct{ mock.Mock }

func (m *mockTodoistTaskCreator) CreateTask(ctx context.Context, requestID string, taskDetails *todoist.CreateTaskRequest) (*todoist.Task, error) {
	args := m.Called(ctx, requestID, taskDetails)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*todoist.Task), args.Error(1)
}

const (
	testPrivateKey = "private-key"
	testPublicKey  = "public-key"
	testEmail      = "test@example.com"
)

func TestTodoServer_PopulateTodo(t *testing.T) {
	t.Run("unsupported app", func(t *testing.T) {
		server := &todoServer{}

		req := &pb.TodoRequest{
			App:     pb.TodoApp_TODO_APP_UNSPECIFIED,
			Method:  pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET,
			Subject: "Test Todo",
			Body:    "Test Body",
		}

		resp, err := server.PopulateTodo(context.Background(), req)

		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "unsupported app")
	})

	t.Run("unsupported method for app", func(t *testing.T) {
		server := &todoServer{}

		// Try to use Notion method with DIDA365 app
		req := &pb.TodoRequest{
			App:     pb.TodoApp_TODO_APP_DIDA365,
			Method:  pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_NOTION,
			Subject: "Test Todo",
			Body:    "Test Body",
		}

		resp, err := server.PopulateTodo(context.Background(), req)

		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "unsupported method")
		assert.Contains(t, err.Error(), "DIDA365")
	})

	t.Run("valid app and method combination - routes correctly", func(t *testing.T) {
		server := &todoServer{}

		testCases := []struct {
			name   string
			app    pb.TodoApp
			method pb.PopullateTodoMethod
		}{
			{
				name:   "DIDA365 with Mailjet",
				app:    pb.TodoApp_TODO_APP_DIDA365,
				method: pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET,
			},
			{
				name:   "Notion with Notion method",
				app:    pb.TodoApp_TODO_APP_NOTION,
				method: pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_NOTION,
			},
			{
				name:   "Todoist with Todoist method",
				app:    pb.TodoApp_TODO_APP_TODOIST,
				method: pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_TODOIST,
			},
		}

		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				req := &pb.TodoRequest{
					App:     tc.app,
					Method:  tc.method,
					Subject: "Test Todo",
					Body:    "Test Body",
				}

				// These will fail at the actual implementation level due to missing credentials
				// but should pass the routing validation
				resp, err := server.PopulateTodo(context.Background(), req)

				assert.Error(t, err) // Expected to fail at implementation level
				assert.Nil(t, resp)
				// Should not fail on routing validation
				assert.NotContains(t, err.Error(), "unsupported app")
				assert.NotContains(t, err.Error(), "unsupported method")
			})
		}
	})
}

func TestValidateMailjetFlags(t *testing.T) {
	t.Run("fails with empty public key", func(t *testing.T) {
		// Save original values
		originalPublic := *mailjetAPIKeyPublic
		originalPrivate := *mailjetAPIKeyPrivate
		originalEmail := *targetEmail
		defer func() {
			*mailjetAPIKeyPublic = originalPublic
			*mailjetAPIKeyPrivate = originalPrivate
			*targetEmail = originalEmail
		}()

		*mailjetAPIKeyPublic = ""
		*mailjetAPIKeyPrivate = testPrivateKey
		*targetEmail = testEmail

		err := validateMailjetFlags()
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "missing mailjet API public key")
	})

	t.Run("fails with empty private key", func(t *testing.T) {
		// Save original values
		originalPublic := *mailjetAPIKeyPublic
		originalPrivate := *mailjetAPIKeyPrivate
		originalEmail := *targetEmail
		defer func() {
			*mailjetAPIKeyPublic = originalPublic
			*mailjetAPIKeyPrivate = originalPrivate
			*targetEmail = originalEmail
		}()

		*mailjetAPIKeyPublic = testPublicKey
		*mailjetAPIKeyPrivate = ""
		*targetEmail = testEmail

		err := validateMailjetFlags()
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "missing mailjet API private key")
	})

	t.Run("fails with invalid email format", func(t *testing.T) {
		// Save original values
		originalPublic := *mailjetAPIKeyPublic
		originalPrivate := *mailjetAPIKeyPrivate
		originalEmail := *targetEmail
		defer func() {
			*mailjetAPIKeyPublic = originalPublic
			*mailjetAPIKeyPrivate = originalPrivate
			*targetEmail = originalEmail
		}()

		*mailjetAPIKeyPublic = "public-key"
		*mailjetAPIKeyPrivate = "private-key"
		*targetEmail = "invalid-email"

		err := validateMailjetFlags()
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "invalid target email address")
	})

	t.Run("succeeds with valid configuration", func(t *testing.T) {
		// Save original values
		originalPublic := *mailjetAPIKeyPublic
		originalPrivate := *mailjetAPIKeyPrivate
		originalEmail := *targetEmail
		defer func() {
			*mailjetAPIKeyPublic = originalPublic
			*mailjetAPIKeyPrivate = originalPrivate
			*targetEmail = originalEmail
		}()

		*mailjetAPIKeyPublic = testPublicKey
		*mailjetAPIKeyPrivate = testPrivateKey
		*targetEmail = testEmail

		err := validateMailjetFlags()
		assert.NoError(t, err)
	})
}

func TestTodoServer_PopulateTodoByMailjet(t *testing.T) {
	t.Run("fails validation with missing credentials", func(t *testing.T) {
		server := &todoServer{}

		// Save original values
		originalPublic := *mailjetAPIKeyPublic
		originalPrivate := *mailjetAPIKeyPrivate
		originalEmail := *targetEmail
		defer func() {
			*mailjetAPIKeyPublic = originalPublic
			*mailjetAPIKeyPrivate = originalPrivate
			*targetEmail = originalEmail
		}()

		// Clear credentials
		*mailjetAPIKeyPublic = ""
		*mailjetAPIKeyPrivate = ""
		*targetEmail = ""

		req := &pb.TodoRequest{
			App:     pb.TodoApp_TODO_APP_DIDA365,
			Method:  pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET,
			Subject: "Test Todo",
			Body:    "Test Body",
		}

		resp, err := server.PopulateTodoByMailjet(context.Background(), req)

		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "missing mailjet API")
	})

	t.Run("passes validation with proper credentials", func(t *testing.T) {
		server := &todoServer{}

		// Save original values
		originalPublic := *mailjetAPIKeyPublic
		originalPrivate := *mailjetAPIKeyPrivate
		originalEmail := *targetEmail
		defer func() {
			*mailjetAPIKeyPublic = originalPublic
			*mailjetAPIKeyPrivate = originalPrivate
			*targetEmail = originalEmail
		}()

		// Set valid test credentials
		*mailjetAPIKeyPublic = "test-public-key"
		*mailjetAPIKeyPrivate = "test-private-key"
		*targetEmail = testEmail

		req := &pb.TodoRequest{
			App:     pb.TodoApp_TODO_APP_DIDA365,
			Method:  pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET,
			Subject: "Test Todo",
			Body:    "Test Body",
		}

		// This will fail at the API call level but should pass validation
		resp, err := server.PopulateTodoByMailjet(context.Background(), req)

		assert.Error(t, err) // Expected to fail at API level
		assert.Nil(t, resp)
		// Should not fail on validation
		assert.NotContains(t, err.Error(), "missing mailjet API")
		assert.NotContains(t, err.Error(), "invalid target email")
	})
}

func TestTodoRequestValidation(t *testing.T) {
	t.Run("validates app and method combinations", func(t *testing.T) {
		validCombinations := map[pb.TodoApp][]pb.PopullateTodoMethod{
			pb.TodoApp_TODO_APP_DIDA365: {pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET},
			pb.TodoApp_TODO_APP_NOTION:  {pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_NOTION},
			pb.TodoApp_TODO_APP_TODOIST: {pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_TODOIST},
		}

		server := &todoServer{}

		for app, methods := range validCombinations {
			for _, method := range methods {
				req := &pb.TodoRequest{
					App:     app,
					Method:  method,
					Subject: "Test",
					Body:    "Test Body",
				}

				// Should pass initial validation (will fail later at implementation)
				_, err := server.PopulateTodo(context.Background(), req)
				assert.Error(t, err) // Expected to fail at implementation
				assert.NotContains(t, err.Error(), "unsupported app")
				assert.NotContains(t, err.Error(), "unsupported method")
			}
		}
	})

	t.Run("rejects invalid combinations", func(t *testing.T) {
		invalidCombinations := []struct {
			app    pb.TodoApp
			method pb.PopullateTodoMethod
		}{
			{pb.TodoApp_TODO_APP_DIDA365, pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_NOTION},
			{pb.TodoApp_TODO_APP_DIDA365, pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_TODOIST},
			{pb.TodoApp_TODO_APP_NOTION, pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET},
			{pb.TodoApp_TODO_APP_NOTION, pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_TODOIST},
			{pb.TodoApp_TODO_APP_TODOIST, pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET},
			{pb.TodoApp_TODO_APP_TODOIST, pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_NOTION},
		}

		server := &todoServer{}

		for _, combo := range invalidCombinations {
			req := &pb.TodoRequest{
				App:     combo.app,
				Method:  combo.method,
				Subject: "Test",
				Body:    "Test Body",
			}

			_, err := server.PopulateTodo(context.Background(), req)
			assert.Error(t, err)
			assert.Contains(t, err.Error(), "unsupported method")
		}
	})
}

func TestValidateNotionFlags(t *testing.T) {
	t.Run("fails with missing API key", func(t *testing.T) {
		originalKey := *notionAPIKey
		originalDB := *notionDataBaseID
		defer func() {
			*notionAPIKey = originalKey
			*notionDataBaseID = originalDB
		}()

		*notionAPIKey = ""
		*notionDataBaseID = "db-123"

		err := validateNotionFlags()
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "missing notion API key")
	})

	t.Run("fails with missing database ID", func(t *testing.T) {
		originalKey := *notionAPIKey
		originalDB := *notionDataBaseID
		defer func() {
			*notionAPIKey = originalKey
			*notionDataBaseID = originalDB
		}()

		*notionAPIKey = "test-key"
		*notionDataBaseID = ""

		err := validateNotionFlags()
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "missing notion database ID")
	})

	t.Run("succeeds with valid configuration", func(t *testing.T) {
		originalKey := *notionAPIKey
		originalDB := *notionDataBaseID
		defer func() {
			*notionAPIKey = originalKey
			*notionDataBaseID = originalDB
		}()

		*notionAPIKey = "test-key"
		*notionDataBaseID = "db-123"

		err := validateNotionFlags()
		assert.NoError(t, err)
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

		*todoistAPIKey = "test-key"

		err := validateTodoistFlags()
		assert.NoError(t, err)
	})
}

func TestPopulateTodoByMailjet_DI(t *testing.T) {
	// helper to save/restore mailjet flags
	saveMailjetFlags := func() func() {
		origPub := *mailjetAPIKeyPublic
		origPriv := *mailjetAPIKeyPrivate
		origEmail := *targetEmail
		return func() {
			*mailjetAPIKeyPublic = origPub
			*mailjetAPIKeyPrivate = origPriv
			*targetEmail = origEmail
		}
	}

	t.Run("success", func(t *testing.T) {
		defer saveMailjetFlags()()
		*mailjetAPIKeyPublic = "test-public"
		*mailjetAPIKeyPrivate = "test-private"
		*targetEmail = "test@example.com"

		mockSender := new(mockMailjetSender)
		mockSender.On("SendMailV31", mock.Anything, mock.Anything).Return(&mailjet.ResultsV31{
			ResultsV31: []mailjet.ResultV31{
				{
					To: []mailjet.GeneratedMessageV31{
						{MessageHref: "https://api.mailjet.com/v3/message/123"},
					},
				},
			},
		}, nil)

		server := &todoServer{
			newMailjetClient: func(pub, priv string) mailjetSender {
				return mockSender
			},
			fetchStatus: func(url, username, password string) (interface{}, error) {
				return map[string]interface{}{"status": "sent"}, nil
			},
		}

		req := &pb.TodoRequest{
			App:     pb.TodoApp_TODO_APP_DIDA365,
			Method:  pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET,
			Subject: "Test Todo",
			Body:    "Test Body",
		}

		resp, err := server.PopulateTodoByMailjet(context.Background(), req)
		assert.NoError(t, err)
		assert.NotNil(t, resp)
		assert.Contains(t, resp.Message, "status")
		mockSender.AssertExpectations(t)
	})

	t.Run("send error", func(t *testing.T) {
		defer saveMailjetFlags()()
		*mailjetAPIKeyPublic = "test-public"
		*mailjetAPIKeyPrivate = "test-private"
		*targetEmail = "test@example.com"

		mockSender := new(mockMailjetSender)
		mockSender.On("SendMailV31", mock.Anything, mock.Anything).Return(nil, assert.AnError)

		server := &todoServer{
			newMailjetClient: func(pub, priv string) mailjetSender {
				return mockSender
			},
		}

		req := &pb.TodoRequest{
			Subject: "Test Todo",
			Body:    "Test Body",
		}

		resp, err := server.PopulateTodoByMailjet(context.Background(), req)
		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "mailjet send email error")
		mockSender.AssertExpectations(t)
	})

	t.Run("empty results", func(t *testing.T) {
		defer saveMailjetFlags()()
		*mailjetAPIKeyPublic = "test-public"
		*mailjetAPIKeyPrivate = "test-private"
		*targetEmail = "test@example.com"

		mockSender := new(mockMailjetSender)
		mockSender.On("SendMailV31", mock.Anything, mock.Anything).Return(&mailjet.ResultsV31{
			ResultsV31: []mailjet.ResultV31{},
		}, nil)

		server := &todoServer{
			newMailjetClient: func(pub, priv string) mailjetSender {
				return mockSender
			},
		}

		req := &pb.TodoRequest{
			Subject: "Test Todo",
			Body:    "Test Body",
		}

		resp, err := server.PopulateTodoByMailjet(context.Background(), req)
		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "mailjet send email API response error")
		mockSender.AssertExpectations(t)
	})

	t.Run("fetch status error", func(t *testing.T) {
		defer saveMailjetFlags()()
		*mailjetAPIKeyPublic = "test-public"
		*mailjetAPIKeyPrivate = "test-private"
		*targetEmail = "test@example.com"

		mockSender := new(mockMailjetSender)
		mockSender.On("SendMailV31", mock.Anything, mock.Anything).Return(&mailjet.ResultsV31{
			ResultsV31: []mailjet.ResultV31{
				{
					To: []mailjet.GeneratedMessageV31{
						{MessageHref: "https://api.mailjet.com/v3/message/123"},
					},
				},
			},
		}, nil)

		server := &todoServer{
			newMailjetClient: func(pub, priv string) mailjetSender {
				return mockSender
			},
			fetchStatus: func(url, username, password string) (interface{}, error) {
				return nil, assert.AnError
			},
		}

		req := &pb.TodoRequest{
			Subject: "Test Todo",
			Body:    "Test Body",
		}

		resp, err := server.PopulateTodoByMailjet(context.Background(), req)
		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "fetch mailjet email status error")
		mockSender.AssertExpectations(t)
	})
}

func TestPopulateTodoByNotion_DI(t *testing.T) {
	saveNotionFlags := func() func() {
		origKey := *notionAPIKey
		origDB := *notionDataBaseID
		return func() {
			*notionAPIKey = origKey
			*notionDataBaseID = origDB
		}
	}

	t.Run("success", func(t *testing.T) {
		defer saveNotionFlags()()
		*notionAPIKey = "test-key"
		*notionDataBaseID = "db-123"

		mockCreator := new(mockNotionPageCreator)
		mockCreator.On("Create", mock.Anything, mock.Anything).Return(&notionapi.Page{
			ID: notionapi.ObjectID("page-123"),
		}, nil)

		server := &todoServer{
			newNotionClient: func(apiKey string) notionPageCreator {
				return mockCreator
			},
		}

		req := &pb.TodoRequest{
			App:     pb.TodoApp_TODO_APP_NOTION,
			Method:  pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_NOTION,
			Subject: "Test Todo",
			Body:    "Test Body",
			From:    "test-source",
		}

		resp, err := server.PopulateTodoByNotion(context.Background(), req)
		assert.NoError(t, err)
		assert.NotNil(t, resp)
		assert.Equal(t, "page-123", resp.Id)
		assert.Contains(t, resp.Message, "page-123")
		mockCreator.AssertExpectations(t)
	})

	t.Run("create error", func(t *testing.T) {
		defer saveNotionFlags()()
		*notionAPIKey = "test-key"
		*notionDataBaseID = "db-123"

		mockCreator := new(mockNotionPageCreator)
		mockCreator.On("Create", mock.Anything, mock.Anything).Return(nil, assert.AnError)

		server := &todoServer{
			newNotionClient: func(apiKey string) notionPageCreator {
				return mockCreator
			},
		}

		req := &pb.TodoRequest{
			Subject: "Test Todo",
			Body:    "Test Body",
		}

		resp, err := server.PopulateTodoByNotion(context.Background(), req)
		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "failed to create page in database")
		mockCreator.AssertExpectations(t)
	})
}

func TestPopulateTodoByTodoist_DI(t *testing.T) {
	saveTodoistFlags := func() func() {
		origKey := *todoistAPIKey
		origProject := *todoistProjectID
		return func() {
			*todoistAPIKey = origKey
			*todoistProjectID = origProject
		}
	}

	t.Run("success", func(t *testing.T) {
		defer saveTodoistFlags()()
		*todoistAPIKey = "test-key"
		*todoistProjectID = ""

		mockCreator := new(mockTodoistTaskCreator)
		mockCreator.On("CreateTask", mock.Anything, mock.Anything, mock.Anything).Return(&todoist.Task{
			ID:      "task-123",
			Content: "Test",
		}, nil)

		server := &todoServer{
			newTodoistClient: func(apiKey string) todoistTaskCreator {
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
		*todoistAPIKey = "test-key"

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

	t.Run("with project ID", func(t *testing.T) {
		defer saveTodoistFlags()()
		*todoistAPIKey = "test-key"
		*todoistProjectID = "proj-456"

		mockCreator := new(mockTodoistTaskCreator)
		mockCreator.On("CreateTask", mock.Anything, mock.Anything, mock.MatchedBy(func(req *todoist.CreateTaskRequest) bool {
			return req.ProjectID == "proj-456"
		})).Return(&todoist.Task{
			ID:      "task-789",
			Content: "Test",
		}, nil)

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
		assert.NoError(t, err)
		assert.NotNil(t, resp)
		assert.Equal(t, "task-789", resp.Id)
		mockCreator.AssertExpectations(t)
	})
}
