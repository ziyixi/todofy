package main

import (
	"net/http"
	"net/http/httptest"
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
}

func TestHandleDependencyBootstrapMissingKeys(t *testing.T) {
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
}

func TestHandleDependencyStatus_Validation(t *testing.T) {
	mockDependency := new(mocks.MockDependencyServiceClient)
	router := setupDependencyHandlerRouter(mockDependency, nil)
	req, _ := http.NewRequest(http.MethodGet, "/dependency/status", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "task_key or todoist_task_id is required")
}

func TestHandleDependencyStatus_NotFound(t *testing.T) {
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
}

func TestHandleTodoistWebhook(t *testing.T) {
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
				req.GetTaskKeys()[0] == "alpha"
		}),
		mock.Anything,
	).Return(&pb.MarkDependencyGraphDirtyResponse{Accepted: true}, nil)

	router := setupDependencyHandlerRouter(mockDependency, mockTodoist)
	body := `{"event_data":{"id":"task-1","content":"Sample <k:alpha>"}}`
	req, _ := http.NewRequest(http.MethodPost, "/todoist/webhook", strings.NewReader(body))
	req.Header.Set("X-Todoist-Hmac-SHA256", "signature")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "\"accepted\":true")
	mockTodoist.AssertExpectations(t)
	mockDependency.AssertExpectations(t)
}
