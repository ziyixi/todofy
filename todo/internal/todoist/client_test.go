package todoist

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClient_CreateTask(t *testing.T) {
	t.Run("successful task creation", func(t *testing.T) {
		// Mock server
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, "POST", r.Method)
			assert.Equal(t, "/tasks", r.URL.Path)
			assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
			assert.Equal(t, "Bearer test-token", r.Header.Get("Authorization"))
			assert.Equal(t, "req-123", r.Header.Get("X-Request-Id"))

			// Verify request body
			var taskReq CreateTaskRequest
			err := json.NewDecoder(r.Body).Decode(&taskReq)
			require.NoError(t, err)
			assert.Equal(t, "Test Task", taskReq.Content)
			assert.Equal(t, "123", taskReq.ProjectID)

			// Return mock response
			response := Task{
				ID:        "456",
				Content:   "Test Task",
				ProjectID: "123",
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(response) // Best effort encoding
		}))
		defer server.Close()

		client := NewClient("test-token")
		client.baseURL = server.URL

		taskReq := &CreateTaskRequest{
			Content:   "Test Task",
			ProjectID: "123",
		}

		result, err := client.CreateTask(context.Background(), "req-123", taskReq)

		assert.NoError(t, err)
		assert.NotNil(t, result)
		assert.Equal(t, "456", result.ID)
		assert.Equal(t, "Test Task", result.Content)
		assert.Equal(t, "123", result.ProjectID)
	})

	t.Run("API error response", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error": "Invalid request"}`)) // Best effort write
		}))
		defer server.Close()

		client := NewClient("test-token")
		client.baseURL = server.URL

		taskReq := &CreateTaskRequest{
			Content:   "Test Task",
			ProjectID: "123",
		}

		result, err := client.CreateTask(context.Background(), "req-123", taskReq)

		assert.Error(t, err)
		assert.Nil(t, result)
		assert.Contains(t, err.Error(), "400")
	})

	t.Run("network error", func(t *testing.T) {
		client := NewClient("test-token")
		client.baseURL = "http://non-existent-server"

		taskReq := &CreateTaskRequest{
			Content:   "Test Task",
			ProjectID: "123",
		}

		result, err := client.CreateTask(context.Background(), "req-123", taskReq)

		assert.Error(t, err)
		assert.Nil(t, result)
	})

	t.Run("empty token", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			auth := r.Header.Get("Authorization")
			assert.Equal(t, "Bearer", auth) // Empty token results in "Bearer" (no space)

			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error": "Unauthorized"}`)) // Best effort write
		}))
		defer server.Close()

		client := NewClient("")
		client.baseURL = server.URL

		taskReq := &CreateTaskRequest{
			Content:   "Test Task",
			ProjectID: "123",
		}

		result, err := client.CreateTask(context.Background(), "req-123", taskReq)

		assert.Error(t, err)
		assert.Nil(t, result)
		assert.Contains(t, err.Error(), "401")
	})

	t.Run("nil task request", func(t *testing.T) {
		// When marshalling nil, it results in "null" JSON which is valid JSON
		// but may cause API errors. Let's test this properly.
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error": "Bad Request"}`)) // Best effort write
		}))
		defer server.Close()

		client := NewClient("test-token")
		client.baseURL = server.URL

		result, err := client.CreateTask(context.Background(), "req-123", nil)

		assert.Error(t, err)
		assert.Nil(t, result)
		// The error should be about the API response, not marshalling
		assert.Contains(t, err.Error(), "400")
	})

	t.Run("empty content", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error": "Content is required"}`)) // Best effort write
		}))
		defer server.Close()

		client := NewClient("test-token")
		client.baseURL = server.URL

		taskReq := &CreateTaskRequest{
			Content:   "",
			ProjectID: "123",
		}

		result, err := client.CreateTask(context.Background(), "req-123", taskReq)

		assert.Error(t, err)
		assert.Nil(t, result)
	})

	t.Run("without request ID", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestID := r.Header.Get("X-Request-Id")
			assert.Empty(t, requestID)

			response := Task{ID: "123", Content: "Test"}
			_ = json.NewEncoder(w).Encode(response) // Best effort encoding
		}))
		defer server.Close()

		client := NewClient("test-token")
		client.baseURL = server.URL

		taskReq := &CreateTaskRequest{Content: "Test", ProjectID: "123"}
		result, err := client.CreateTask(context.Background(), "", taskReq)

		assert.NoError(t, err)
		assert.NotNil(t, result)
	})
}

func TestClient_Authentication(t *testing.T) {
	t.Run("includes correct authorization header", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			auth := r.Header.Get("Authorization")
			assert.Equal(t, "Bearer my-secret-token", auth)

			response := Task{ID: "123", Content: "Test"}
			_ = json.NewEncoder(w).Encode(response) // Best effort encoding
		}))
		defer server.Close()

		client := NewClient("my-secret-token")
		client.baseURL = server.URL

		taskReq := &CreateTaskRequest{Content: "Test", ProjectID: "123"}
		_, err := client.CreateTask(context.Background(), "req-123", taskReq)

		assert.NoError(t, err)
	})
}

func TestClient_RequestID(t *testing.T) {
	t.Run("includes request ID when provided", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestID := r.Header.Get("X-Request-Id")
			assert.Equal(t, "test-request-123", requestID)

			response := Task{ID: "123", Content: "Test"}
			_ = json.NewEncoder(w).Encode(response) // Best effort encode
		}))
		defer server.Close()

		client := NewClient("test-token")
		client.baseURL = server.URL

		taskReq := &CreateTaskRequest{
			Content:   "Test",
			ProjectID: "123",
		}

		_, err := client.CreateTask(context.Background(), "test-request-123", taskReq)

		assert.NoError(t, err)
	})

	t.Run("works without request ID", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestID := r.Header.Get("X-Request-Id")
			assert.Empty(t, requestID)

			response := Task{ID: "123", Content: "Test"}
			_ = json.NewEncoder(w).Encode(response) // Best effort encode
		}))
		defer server.Close()

		client := NewClient("test-token")
		client.baseURL = server.URL

		taskReq := &CreateTaskRequest{Content: "Test", ProjectID: "123"}
		_, err := client.CreateTask(context.Background(), "", taskReq)

		assert.NoError(t, err)
	})
}

func TestNewClient(t *testing.T) {
	t.Run("creates client with token", func(t *testing.T) {
		client := NewClient("my-token")

		assert.NotNil(t, client)
		assert.Equal(t, "my-token", client.token)
		assert.Equal(t, "https://api.todoist.com/rest/v2", client.baseURL)
	})

	t.Run("creates client with empty token", func(t *testing.T) {
		client := NewClient("")

		assert.NotNil(t, client)
		assert.Empty(t, client.token)
		assert.Equal(t, "https://api.todoist.com/rest/v2", client.baseURL)
	})
}

func TestTask_Validation(t *testing.T) {
	t.Run("valid CreateTaskRequest structure", func(t *testing.T) {
		task := CreateTaskRequest{
			Content:     "My task",
			ProjectID:   "456",
			Description: "Task description",
			Priority:    1,
		}

		// Test that task can be marshalled and unmarshalled
		data, err := json.Marshal(task)
		assert.NoError(t, err)
		assert.NotEmpty(t, data)

		var unmarshalled CreateTaskRequest
		err = json.Unmarshal(data, &unmarshalled)
		assert.NoError(t, err)
		assert.Equal(t, task, unmarshalled)
	})

	t.Run("valid Task structure", func(t *testing.T) {
		task := Task{
			ID:          "123",
			Content:     "My task",
			ProjectID:   "456",
			Description: "Task description",
			Priority:    1,
		}

		// Test that task can be marshalled and unmarshalled
		data, err := json.Marshal(task)
		assert.NoError(t, err)
		assert.NotEmpty(t, data)

		var unmarshalled Task
		err = json.Unmarshal(data, &unmarshalled)
		assert.NoError(t, err)
		assert.Equal(t, task, unmarshalled)
	})

	t.Run("CreateTaskRequest JSON tags", func(t *testing.T) {
		task := CreateTaskRequest{
			Content:   "Test",
			ProjectID: "456",
		}

		data, err := json.Marshal(task)
		assert.NoError(t, err)

		// Verify JSON structure
		var jsonData map[string]interface{}
		err = json.Unmarshal(data, &jsonData)
		assert.NoError(t, err)

		assert.Equal(t, "Test", jsonData["content"])
		assert.Equal(t, "456", jsonData["project_id"])
	})

	t.Run("Task JSON tags", func(t *testing.T) {
		task := Task{
			ID:        "123",
			Content:   "Test",
			ProjectID: "456",
		}

		data, err := json.Marshal(task)
		assert.NoError(t, err)

		// Verify JSON structure
		var jsonData map[string]interface{}
		err = json.Unmarshal(data, &jsonData)
		assert.NoError(t, err)

		assert.Equal(t, "123", jsonData["id"])
		assert.Equal(t, "Test", jsonData["content"])
		assert.Equal(t, "456", jsonData["project_id"])
	})
}
