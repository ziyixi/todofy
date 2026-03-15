package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/ziyixi/todofy/testutils/mocks"
	"github.com/ziyixi/todofy/utils"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/ziyixi/protos/go/todofy"
)

const testDependencyTaskKey = "alpha"

func setupDependencyHandlerRouter(
	mockDependency *mocks.MockDependencyServiceClient,
	mockTodoist *mocks.MockTodoistServiceClient,
) *gin.Engine {
	gin.SetMode(gin.TestMode)
	clients := mocks.NewMockGRPCClients()
	if mockDependency != nil {
		clients.SetClient("dependency", mockDependency)
	}
	if mockTodoist != nil {
		clients.SetClient("todoist", mockTodoist)
	}

	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(utils.KeyGRPCClients, clients)
		c.Next()
	})
	router.POST("/dependency/reconcile", HandleDependencyReconcile)
	router.POST("/dependency/bootstrap_keys", HandleDependencyBootstrapMissingKeys)
	router.GET("/dependency/status", HandleDependencyStatus)
	router.GET("/dependency/issues", HandleDependencyIssues)
	router.POST("/todoist/webhook", HandleTodoistWebhook)
	return router
}

func TestHandleDependencyReconcile(t *testing.T) {
	t.Run("dry run analyze", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("AnalyzeGraph", mock.Anything, mock.Anything, mock.Anything).
			Return(&pb.AnalyzeDependencyGraphResponse{TaskCount: 3}, nil)

		router := setupDependencyHandlerRouter(mockDependency, nil)
		req, _ := http.NewRequest(http.MethodPost, "/dependency/reconcile?dry_run=true", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Body.String(), "dry_run")
		mockDependency.AssertExpectations(t)
	})

	t.Run("write reconcile", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("ReconcileGraph", mock.Anything, mock.Anything, mock.Anything).
			Return(&pb.ReconcileDependencyGraphResponse{TaskCount: 2, UpdatedTaskCount: 1}, nil)

		router := setupDependencyHandlerRouter(mockDependency, nil)
		req, _ := http.NewRequest(http.MethodPost, "/dependency/reconcile", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Body.String(), "\"updated_task_count\":1")
		mockDependency.AssertExpectations(t)
	})

	t.Run("invalid dry_run returns bad request", func(t *testing.T) {
		router := setupDependencyHandlerRouter(new(mocks.MockDependencyServiceClient), nil)
		req, _ := http.NewRequest(http.MethodPost, "/dependency/reconcile?dry_run=maybe", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusBadRequest, w.Code)
		assert.Contains(t, w.Body.String(), "invalid syntax")
	})
}

func TestHandleDependencyBootstrapMissingKeys(t *testing.T) {
	t.Run("default dry run is true", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("BootstrapMissingTaskKeys", mock.Anything,
			mock.MatchedBy(func(req *pb.BootstrapMissingTaskKeysRequest) bool {
				return req.GetDryRun()
			}),
			mock.Anything,
		).Return(&pb.BootstrapMissingTaskKeysResponse{GeneratedCount: 1}, nil)

		router := setupDependencyHandlerRouter(mockDependency, nil)
		req, _ := http.NewRequest(http.MethodPost, "/dependency/bootstrap_keys", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Body.String(), "\"generated_count\":1")
		mockDependency.AssertExpectations(t)
	})

	t.Run("explicit false dry run is passed through", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("BootstrapMissingTaskKeys", mock.Anything,
			mock.MatchedBy(func(req *pb.BootstrapMissingTaskKeysRequest) bool {
				return !req.GetDryRun()
			}),
			mock.Anything,
		).Return(&pb.BootstrapMissingTaskKeysResponse{}, nil)

		router := setupDependencyHandlerRouter(mockDependency, nil)
		req, _ := http.NewRequest(http.MethodPost, "/dependency/bootstrap_keys?dry_run=false", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		mockDependency.AssertExpectations(t)
	})
}

func TestHandleDependencyStatus(t *testing.T) {
	t.Run("validation failure", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		router := setupDependencyHandlerRouter(mockDependency, nil)
		req, _ := http.NewRequest(http.MethodGet, "/dependency/status", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusBadRequest, w.Code)
		assert.Contains(t, w.Body.String(), "task_key or todoist_task_id is required")
	})

	t.Run("success by task key", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("GetTaskStatus", mock.Anything,
			mock.MatchedBy(func(req *pb.GetTaskDependencyStatusRequest) bool {
				return req.GetTaskKey() == testDependencyTaskKey && req.GetTodoistTaskId() == ""
			}),
			mock.Anything,
		).Return(&pb.GetTaskDependencyStatusResponse{
			Status: &pb.TaskDependencyStatus{TaskKey: testDependencyTaskKey},
		}, nil)

		router := setupDependencyHandlerRouter(mockDependency, nil)
		req, _ := http.NewRequest(
			http.MethodGet,
			"/dependency/status?task_key="+testDependencyTaskKey,
			nil,
		)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Body.String(), "\"task_key\":\""+testDependencyTaskKey+"\"")
		mockDependency.AssertExpectations(t)
	})

	t.Run("not found", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("GetTaskStatus", mock.Anything, mock.Anything, mock.Anything).
			Return(nil, status.Error(codes.NotFound, "task status not found"))

		router := setupDependencyHandlerRouter(mockDependency, nil)
		req, _ := http.NewRequest(http.MethodGet, "/dependency/status?task_key=missing", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusNotFound, w.Code)
		assert.Contains(t, w.Body.String(), "task status not found")
		mockDependency.AssertExpectations(t)
	})

	t.Run("internal error", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("GetTaskStatus", mock.Anything, mock.Anything, mock.Anything).
			Return(nil, assert.AnError)

		router := setupDependencyHandlerRouter(mockDependency, nil)
		req, _ := http.NewRequest(http.MethodGet, "/dependency/status?todoist_task_id=task-1", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusInternalServerError, w.Code)
		assert.Contains(t, w.Body.String(), assert.AnError.Error())
		mockDependency.AssertExpectations(t)
	})
}

func TestHandleDependencyIssues(t *testing.T) {
	t.Run("success with filters", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("ListDependencyIssues", mock.Anything,
			mock.MatchedBy(func(req *pb.ListDependencyIssuesRequest) bool {
				return req.GetType() == pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_BROKEN_REFERENCE &&
					req.GetTaskKey() == testDependencyTaskKey
			}),
			mock.Anything,
		).Return(&pb.ListDependencyIssuesResponse{
			Issues: []*pb.DependencyIssue{
				{
					TaskKey: testDependencyTaskKey,
					Type:    pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_BROKEN_REFERENCE,
				},
			},
		}, nil)

		router := setupDependencyHandlerRouter(mockDependency, nil)
		req, _ := http.NewRequest(
			http.MethodGet,
			"/dependency/issues?type=broken_reference&task_key="+testDependencyTaskKey,
			nil,
		)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Body.String(), "\"task_key\":\""+testDependencyTaskKey+"\"")
		mockDependency.AssertExpectations(t)
	})

	t.Run("invalid type returns bad request", func(t *testing.T) {
		router := setupDependencyHandlerRouter(new(mocks.MockDependencyServiceClient), nil)
		req, _ := http.NewRequest(http.MethodGet, "/dependency/issues?type=bogus", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusBadRequest, w.Code)
		assert.Contains(t, w.Body.String(), "invalid syntax")
	})
}

func TestHandleTodoistWebhook(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockTodoist := new(mocks.MockTodoistServiceClient)

		mockTodoist.On("VerifyWebhook", mock.Anything, mock.Anything, mock.Anything).
			Return(&pb.VerifyTodoistWebhookResponse{
				Valid:  true,
				Reason: "ok",
			}, nil)
		mockDependency.On("MarkGraphDirty", mock.Anything,
			mock.MatchedBy(func(req *pb.MarkDependencyGraphDirtyRequest) bool {
				return req.GetSource() == "todoist_webhook" &&
					len(req.GetTodoistTaskIds()) == 1 &&
					req.GetTodoistTaskIds()[0] == "task-1" &&
					len(req.GetTaskKeys()) == 1 &&
					req.GetTaskKeys()[0] == testDependencyTaskKey
			}),
			mock.Anything,
		).Return(&pb.MarkDependencyGraphDirtyResponse{Accepted: true}, nil)

		router := setupDependencyHandlerRouter(mockDependency, mockTodoist)
		body := `{"event_data":{"id":"task-1","content":"Sample <k:` + testDependencyTaskKey + `>"}}`
		req, _ := http.NewRequest(http.MethodPost, "/todoist/webhook", strings.NewReader(body))
		req.Header.Set("X-Todoist-Hmac-SHA256", "signature")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Body.String(), "\"accepted\":true")
		mockTodoist.AssertExpectations(t)
		mockDependency.AssertExpectations(t)
	})

	t.Run("missing signature returns accepted false without retryable status", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockTodoist := new(mocks.MockTodoistServiceClient)
		mockTodoist.On("VerifyWebhook", mock.Anything, mock.Anything, mock.Anything).
			Return(&pb.VerifyTodoistWebhookResponse{
				Valid:   false,
				Reason:  "missing_signature",
				Details: "signature is required",
			}, nil)

		router := setupDependencyHandlerRouter(mockDependency, mockTodoist)
		req, _ := http.NewRequest(http.MethodPost, "/todoist/webhook", strings.NewReader(`{"event_data":{"id":"task-1"}}`))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Body.String(), "\"accepted\":false")
		assert.Contains(t, w.Body.String(), "missing_signature")
		mockTodoist.AssertExpectations(t)
		mockDependency.AssertNotCalled(t, "MarkGraphDirty", mock.Anything, mock.Anything, mock.Anything)
	})

	t.Run("invalid signature returns accepted false without marking dirty", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockTodoist := new(mocks.MockTodoistServiceClient)
		mockTodoist.On("VerifyWebhook", mock.Anything, mock.Anything, mock.Anything).
			Return(&pb.VerifyTodoistWebhookResponse{
				Valid:   false,
				Reason:  "invalid_signature",
				Details: "signature validation failed",
			}, nil)

		router := setupDependencyHandlerRouter(mockDependency, mockTodoist)
		req, _ := http.NewRequest(http.MethodPost, "/todoist/webhook", strings.NewReader(`{"event_data":{"id":"task-1"}}`))
		req.Header.Set("X-Todoist-Hmac-SHA256", "invalid")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Body.String(), "\"accepted\":false")
		assert.Contains(t, w.Body.String(), "invalid_signature")
		mockTodoist.AssertExpectations(t)
		mockDependency.AssertNotCalled(t, "MarkGraphDirty", mock.Anything, mock.Anything, mock.Anything)
	})

	t.Run("verification errors surface as 500", func(t *testing.T) {
		mockTodoist := new(mocks.MockTodoistServiceClient)
		mockTodoist.On("VerifyWebhook", mock.Anything, mock.Anything, mock.Anything).
			Return(nil, assert.AnError)

		router := setupDependencyHandlerRouter(new(mocks.MockDependencyServiceClient), mockTodoist)
		req, _ := http.NewRequest(http.MethodPost, "/todoist/webhook", strings.NewReader(`{"event_data":{"id":"task-1"}}`))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusInternalServerError, w.Code)
		assert.Contains(t, w.Body.String(), "verify_failed")
		mockTodoist.AssertExpectations(t)
	})

	t.Run("mark graph dirty errors surface as 500", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockTodoist := new(mocks.MockTodoistServiceClient)

		mockTodoist.On("VerifyWebhook", mock.Anything, mock.Anything, mock.Anything).
			Return(&pb.VerifyTodoistWebhookResponse{
				Valid:  true,
				Reason: "ok",
			}, nil)
		mockDependency.On("MarkGraphDirty", mock.Anything, mock.Anything, mock.Anything).
			Return(nil, assert.AnError)

		router := setupDependencyHandlerRouter(mockDependency, mockTodoist)
		req, _ := http.NewRequest(http.MethodPost, "/todoist/webhook", strings.NewReader(`{"event_data":{"id":"task-1"}}`))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusInternalServerError, w.Code)
		assert.Contains(t, w.Body.String(), "mark_graph_dirty_failed")
		mockTodoist.AssertExpectations(t)
		mockDependency.AssertExpectations(t)
	})
}

func TestParseIssueType(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    pb.DependencyIssueType
		wantErr error
	}{
		{
			name:    "empty defaults to unspecified",
			raw:     "",
			want:    pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_UNSPECIFIED,
			wantErr: nil,
		},
		{
			name:    "numeric enum value",
			raw:     strconv.Itoa(int(pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_CYCLE)),
			want:    pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_CYCLE,
			wantErr: nil,
		},
		{
			name:    "symbolic shorthand",
			raw:     "broken_reference",
			want:    pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_BROKEN_REFERENCE,
			wantErr: nil,
		},
		{
			name:    "full enum name",
			raw:     "DEPENDENCY_ISSUE_TYPE_PARSE_ERROR",
			want:    pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_PARSE_ERROR,
			wantErr: nil,
		},
		{
			name:    "out of range numeric",
			raw:     "999",
			want:    pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_UNSPECIFIED,
			wantErr: strconv.ErrRange,
		},
		{
			name:    "invalid symbolic value",
			raw:     "bogus",
			want:    pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_UNSPECIFIED,
			wantErr: strconv.ErrSyntax,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseIssueType(tc.raw)
			assert.Equal(t, tc.want, got)
			if tc.wantErr == nil {
				assert.NoError(t, err)
			} else {
				assert.ErrorIs(t, err, tc.wantErr)
			}
		})
	}
}

func TestWebhookHelperExtraction(t *testing.T) {
	raw := []byte(`{
		"event_data": {
			"id": "task-1",
			"task_id": "task-2",
			"item_id": "task-1",
			"content": "Example <k:alpha dep:beta>",
			"items": [
				{"id": "task-3"},
				{"id": "task-2"},
				{"id": "task-4"},
				{"id": ""}
			]
		}
	}`)

	assert.Equal(t, []string{"task-1", "task-2", "task-3", "task-4"}, extractWebhookTaskIDs(raw))
	assert.Equal(t, []string{"alpha"}, extractWebhookTaskKeys(raw))
	assert.Nil(t, extractWebhookTaskKeys([]byte(`{"event_data":{"content":"not metadata"}}`)))
}

func TestFirstNonEmptyHeader(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	req, _ := http.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Empty", " ")
	req.Header.Set("X-Second", "value-2")
	req.Header.Set("X-Third", "value-3")
	c.Request = req

	assert.Equal(t, "value-2", firstNonEmptyHeader(c, "X-Empty", "X-Second", "X-Third"))
	assert.Empty(t, firstNonEmptyHeader(c, "X-Missing"))
}
