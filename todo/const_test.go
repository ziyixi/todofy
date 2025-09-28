package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	pb "github.com/ziyixi/protos/go/todofy"
)

func TestTodoConstants(t *testing.T) {
	t.Run("sender constants are defined", func(t *testing.T) {
		assert.NotEmpty(t, sender)
		assert.NotEmpty(t, senderName)
		assert.NotEmpty(t, receiverName)

		assert.Equal(t, "ziyixi@mailjet.ziyixi.science", sender)
		assert.Equal(t, "Todofy", senderName)
		assert.Equal(t, "dida365", receiverName)
	})
}

func TestAllowedPopulateTodoMethod(t *testing.T) {
	t.Run("contains expected app mappings", func(t *testing.T) {
		expectedApps := []pb.TodoApp{
			pb.TodoApp_TODO_APP_DIDA365,
			pb.TodoApp_TODO_APP_NOTION,
			pb.TodoApp_TODO_APP_TODOIST,
		}

		for _, app := range expectedApps {
			_, exists := allowedPopullateTodoMethod[app]
			assert.True(t, exists, "App %v should exist in allowedPopullateTodoMethod", app)
		}

		assert.Len(t, allowedPopullateTodoMethod, 3)
	})

	t.Run("DIDA365 supports Mailjet method", func(t *testing.T) {
		methods := allowedPopullateTodoMethod[pb.TodoApp_TODO_APP_DIDA365]
		assert.Contains(t, methods, pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET)
		assert.Len(t, methods, 1)
	})

	t.Run("Notion supports Notion method", func(t *testing.T) {
		methods := allowedPopullateTodoMethod[pb.TodoApp_TODO_APP_NOTION]
		assert.Contains(t, methods, pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_NOTION)
		assert.Len(t, methods, 1)
	})

	t.Run("Todoist supports Todoist method", func(t *testing.T) {
		methods := allowedPopullateTodoMethod[pb.TodoApp_TODO_APP_TODOIST]
		assert.Contains(t, methods, pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_TODOIST)
		assert.Len(t, methods, 1)
	})

	t.Run("all methods are valid", func(t *testing.T) {
		for app, methods := range allowedPopullateTodoMethod {
			assert.NotEmpty(t, methods, "App %v should have at least one method", app)
			for _, method := range methods {
				assert.NotEqual(t, pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_UNSPECIFIED, method)
			}
		}
	})
}

func TestMethodAppCompatibility(t *testing.T) {
	t.Run("each method is only used by appropriate apps", func(t *testing.T) {
		methodToApp := make(map[pb.PopullateTodoMethod][]pb.TodoApp)

		for app, methods := range allowedPopullateTodoMethod {
			for _, method := range methods {
				methodToApp[method] = append(methodToApp[method], app)
			}
		}

		// Each method should be used by exactly one app (based on current design)
		for method, apps := range methodToApp {
			assert.Len(t, apps, 1, "Method %v should only be used by one app", method)
		}
	})

	t.Run("method names align with app types", func(t *testing.T) {
		// Verify logical consistency in method naming
		assert.Contains(t, allowedPopullateTodoMethod[pb.TodoApp_TODO_APP_DIDA365],
			pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET)
		assert.Contains(t, allowedPopullateTodoMethod[pb.TodoApp_TODO_APP_NOTION],
			pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_NOTION)
		assert.Contains(t, allowedPopullateTodoMethod[pb.TodoApp_TODO_APP_TODOIST],
			pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_TODOIST)
	})
}
