package main

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	pb "github.com/ziyixi/protos/go/todofy"
)

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
