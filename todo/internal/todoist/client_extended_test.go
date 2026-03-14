package todoist

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/ziyixi/todofy/utils"
)

func TestClient_ListActiveTasks(t *testing.T) {
	t.Run("supports legacy array response", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, http.MethodGet, r.Method)
			assert.Equal(t, "/tasks", r.URL.Path)
			_ = json.NewEncoder(w).Encode([]Task{
				{ID: "1", Content: "A"},
				{ID: "2", Content: "B"},
			})
		}))
		defer server.Close()

		client := NewClient("token")
		client.baseURL = server.URL

		tasks, err := client.ListActiveTasks(context.Background())
		require.NoError(t, err)
		require.Len(t, tasks, 2)
		assert.Equal(t, "1", tasks[0].ID)
		assert.Equal(t, "2", tasks[1].ID)
	})

	t.Run("supports paginated envelope", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, http.MethodGet, r.Method)
			assert.Equal(t, "/tasks", r.URL.Path)
			switch r.URL.Query().Get("cursor") {
			case "":
				_, _ = w.Write([]byte(`{"results":[{"id":"1","content":"A"}],"next_cursor":"cursor-1"}`))
			case "cursor-1":
				_, _ = w.Write([]byte(`{"results":[{"id":"2","content":"B"}],"next_cursor":""}`))
			default:
				w.WriteHeader(http.StatusBadRequest)
			}
		}))
		defer server.Close()

		client := NewClient("token")
		client.baseURL = server.URL

		tasks, err := client.ListActiveTasks(context.Background())
		require.NoError(t, err)
		require.Len(t, tasks, 2)
		assert.Equal(t, "1", tasks[0].ID)
		assert.Equal(t, "2", tasks[1].ID)
	})
}

func TestClient_UpdateTaskLabels(t *testing.T) {
	const taskPath = "/tasks/123"

	t.Run("skips write when no diff", func(t *testing.T) {
		var postCount int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodGet && r.URL.Path == taskPath:
				_ = json.NewEncoder(w).Encode(Task{ID: "123", Labels: []string{"a", "b"}})
			case r.Method == http.MethodPost && r.URL.Path == taskPath:
				atomic.AddInt32(&postCount, 1)
				_ = json.NewEncoder(w).Encode(Task{ID: "123", Labels: []string{"a", "b"}})
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		defer server.Close()

		client := NewClient("token")
		client.baseURL = server.URL

		task, err := client.UpdateTaskLabels(context.Background(), "123", []string{"b"}, nil)
		require.NoError(t, err)
		require.NotNil(t, task)
		assert.Equal(t, int32(0), atomic.LoadInt32(&postCount))
	})

	t.Run("writes minimal label updates", func(t *testing.T) {
		var wroteLabels []string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodGet && r.URL.Path == taskPath:
				_ = json.NewEncoder(w).Encode(Task{ID: "123", Labels: []string{"a", "b"}})
			case r.Method == http.MethodPost && r.URL.Path == taskPath:
				var req UpdateTaskRequest
				require.NoError(t, json.NewDecoder(r.Body).Decode(&req))
				wroteLabels = append([]string(nil), req.Labels...)
				_ = json.NewEncoder(w).Encode(Task{ID: "123", Labels: req.Labels})
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		defer server.Close()

		client := NewClient("token")
		client.baseURL = server.URL

		task, err := client.UpdateTaskLabels(context.Background(), "123", []string{"c"}, []string{"a"})
		require.NoError(t, err)
		require.NotNil(t, task)
		assert.Equal(t, []string{"b", "c"}, wroteLabels)
		assert.Equal(t, []string{"b", "c"}, task.Labels)
	})
}

func TestClient_EnsureLabels(t *testing.T) {
	var listCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/labels":
			listCalls++
			switch r.URL.Query().Get("cursor") {
			case "":
				_, _ = w.Write([]byte(`{"results":[{"id":"1","name":"dag_blocked"}],"next_cursor":"cursor-1"}`))
			case "cursor-1":
				_, _ = w.Write([]byte(`{"results":[],"next_cursor":""}`))
			default:
				w.WriteHeader(http.StatusBadRequest)
			}
		case r.Method == http.MethodPost && r.URL.Path == "/labels":
			var req createLabelRequest
			require.NoError(t, json.NewDecoder(r.Body).Decode(&req))
			if req.Name == "dag_broken_dep" {
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte(`{"error":"upstream failure"}`))
				return
			}
			_ = json.NewEncoder(w).Encode(Label{ID: "2", Name: req.Name})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := NewClient("token")
	client.baseURL = server.URL

	result, err := client.EnsureLabels(context.Background(), []string{
		"dag_blocked",
		"dag_cycle",
		"dag_broken_dep",
		"dag_cycle",
	})
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, []string{"dag_blocked"}, result.ExistingLabels)
	assert.Equal(t, []string{"dag_cycle"}, result.CreatedLabels)
	assert.Contains(t, result.Failures["dag_broken_dep"], "502")
	assert.Equal(t, 2, listCalls)
}

func TestClient_VerifyWebhook(t *testing.T) {
	client := NewClient("token")
	payload := []byte(`{"event":"item:updated"}`)
	secret := "webhook-secret"

	mac := hmac.New(sha256.New, []byte(secret))
	_, err := mac.Write(payload)
	require.NoError(t, err)
	signature := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	assert.True(t, client.VerifyWebhook(payload, signature, secret))
	assert.False(t, client.VerifyWebhook(payload, "bad-signature", secret))
	assert.False(t, client.VerifyWebhook(payload, signature, ""))
	assert.False(t, client.VerifyWebhook(payload, "", secret))
}

func TestClient_RequestCompliance(t *testing.T) {
	t.Run("rejects oversized POST body before send", func(t *testing.T) {
		var calls int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			atomic.AddInt32(&calls, 1)
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(Task{ID: "1"})
		}))
		defer server.Close()

		client := NewClient("token-body-limit")
		client.baseURL = server.URL

		tooLargeContent := strings.Repeat("a", todoistMaxPostBodyBytes+1024)
		_, err := client.CreateTask(context.Background(), "rid", &CreateTaskRequest{Content: tooLargeContent})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "body too large")
		assert.Equal(t, int32(0), atomic.LoadInt32(&calls))
	})

	t.Run("rejects oversized headers before send", func(t *testing.T) {
		var calls int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			atomic.AddInt32(&calls, 1)
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(Task{ID: "1"})
		}))
		defer server.Close()

		client := NewClient("token-header-limit")
		client.baseURL = server.URL

		tooLargeRequestID := strings.Repeat("r", todoistMaxHeaderBytes)
		_, err := client.CreateTask(context.Background(), tooLargeRequestID, &CreateTaskRequest{Content: "small"})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "headers too large")
		assert.Equal(t, int32(0), atomic.LoadInt32(&calls))
	})

	t.Run("retries once on 429 and then succeeds", func(t *testing.T) {
		var calls int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			n := atomic.AddInt32(&calls, 1)
			if n == 1 {
				w.Header().Set("Retry-After", "0")
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(`{"error":"rate limited"}`))
				return
			}
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(Task{ID: "ok", Content: "done"})
		}))
		defer server.Close()

		client := NewClient("token-retry-429")
		client.baseURL = server.URL
		client.retryConfig = utils.RetryConfig{
			MaxAttempts: 2,
			BaseDelay:   time.Millisecond,
			MaxDelay:    10 * time.Millisecond,
		}

		task, err := client.CreateTask(context.Background(), "rid", &CreateTaskRequest{Content: "A"})
		require.NoError(t, err)
		require.NotNil(t, task)
		assert.Equal(t, "ok", task.ID)
		assert.Equal(t, int32(2), atomic.LoadInt32(&calls))
	})

	t.Run("enforces client-side rate limit", func(t *testing.T) {
		var calls int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			atomic.AddInt32(&calls, 1)
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(Task{ID: "123", Content: "A"})
		}))
		defer server.Close()

		client := NewClient("token-local-rate-limit")
		client.baseURL = server.URL
		client.requestLimiter = utils.NewSlidingWindowLimiter(1, time.Hour)
		client.retryConfig = utils.RetryConfig{
			MaxAttempts: 1,
			BaseDelay:   time.Millisecond,
		}

		_, err := client.GetTask(context.Background(), "123")
		require.NoError(t, err)

		_, err = client.GetTask(context.Background(), "123")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "client-side rate limit exceeded")
		assert.Equal(t, int32(1), atomic.LoadInt32(&calls))
	})
}
