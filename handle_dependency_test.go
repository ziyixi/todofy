package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
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
) *gin.Engine {
	gin.SetMode(gin.TestMode)
	clients := mocks.NewMockGRPCClients()
	if mockDependency != nil {
		clients.SetClient("dependency", mockDependency)
	}

	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(utils.KeyGRPCClients, clients)
		c.Next()
	})
	router.POST("/dependency/reconcile", HandleDependencyReconcile)
	router.POST("/dependency/bootstrap_keys", HandleDependencyBootstrapMissingKeys)
	router.POST("/dependency/clear_metadata", HandleDependencyClearMetadata)
	router.GET("/dependency/status", HandleDependencyStatus)
	router.GET("/dependency/issues", HandleDependencyIssues)
	return router
}

func TestHandleDependencyReconcile(t *testing.T) {
	t.Run("dry run analyze", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("AnalyzeGraph", mock.Anything, mock.Anything, mock.Anything).
			Return(&pb.AnalyzeDependencyGraphResponse{TaskCount: 3}, nil)

		router := setupDependencyHandlerRouter(mockDependency)
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
			Return(&pb.ReconcileDependencyGraphResponse{
				TaskCount:         2,
				UpdatedTaskCount:  1,
				PartialSuccess:    true,
				FailedUpdateCount: 1,
				WriteFailures: []*pb.DependencyWriteFailure{
					{
						TodoistTaskId: "task-1",
						TaskKey:       testDependencyTaskKey,
						Operation:     "update_labels",
						ErrorMessage:  "failed to update Todoist task labels: boom",
					},
				},
			}, nil)

		router := setupDependencyHandlerRouter(mockDependency)
		req, _ := http.NewRequest(http.MethodPost, "/dependency/reconcile", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Body.String(), "\"updated_task_count\":1")
		assert.Contains(t, w.Body.String(), "\"partial_success\":true")
		assert.Contains(t, w.Body.String(), "\"failed_update_count\":1")
		mockDependency.AssertExpectations(t)
	})

	t.Run("deadline exceeded maps to gateway timeout", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("ReconcileGraph", mock.Anything, mock.Anything, mock.Anything).
			Return(nil, status.Error(codes.DeadlineExceeded, "list active Todoist tasks timed out"))

		router := setupDependencyHandlerRouter(mockDependency)
		req, _ := http.NewRequest(http.MethodPost, "/dependency/reconcile", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusGatewayTimeout, w.Code)
		assert.Contains(t, w.Body.String(), "timed out")
		mockDependency.AssertExpectations(t)
	})

	t.Run("invalid dry_run returns bad request", func(t *testing.T) {
		router := setupDependencyHandlerRouter(new(mocks.MockDependencyServiceClient))
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

		router := setupDependencyHandlerRouter(mockDependency)
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

		router := setupDependencyHandlerRouter(mockDependency)
		req, _ := http.NewRequest(http.MethodPost, "/dependency/bootstrap_keys?dry_run=false", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		mockDependency.AssertExpectations(t)
	})

	t.Run("partial success payload is returned as ok", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("BootstrapMissingTaskKeys", mock.Anything, mock.Anything, mock.Anything).
			Return(&pb.BootstrapMissingTaskKeysResponse{
				GeneratedCount:    1,
				PartialSuccess:    true,
				FailedUpdateCount: 1,
				WriteFailures: []*pb.DependencyWriteFailure{
					{
						TodoistTaskId: "task-2",
						TaskKey:       "task-b",
						Operation:     "update_content",
						ErrorMessage:  "failed to update Todoist task content: boom",
					},
				},
			}, nil)

		router := setupDependencyHandlerRouter(mockDependency)
		req, _ := http.NewRequest(http.MethodPost, "/dependency/bootstrap_keys?dry_run=false", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Body.String(), "\"partial_success\":true")
		assert.Contains(t, w.Body.String(), "\"failed_update_count\":1")
		mockDependency.AssertExpectations(t)
	})

	t.Run("deadline exceeded maps to gateway timeout", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("BootstrapMissingTaskKeys", mock.Anything, mock.Anything, mock.Anything).
			Return(nil, status.Error(codes.DeadlineExceeded, "bootstrap timed out"))

		router := setupDependencyHandlerRouter(mockDependency)
		req, _ := http.NewRequest(http.MethodPost, "/dependency/bootstrap_keys?dry_run=false", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusGatewayTimeout, w.Code)
		assert.Contains(t, w.Body.String(), "timed out")
		mockDependency.AssertExpectations(t)
	})
}

func TestHandleDependencyStatus(t *testing.T) {
	t.Run("validation failure", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		router := setupDependencyHandlerRouter(mockDependency)
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

		router := setupDependencyHandlerRouter(mockDependency)
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

		router := setupDependencyHandlerRouter(mockDependency)
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

		router := setupDependencyHandlerRouter(mockDependency)
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

		router := setupDependencyHandlerRouter(mockDependency)
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
		router := setupDependencyHandlerRouter(new(mocks.MockDependencyServiceClient))
		req, _ := http.NewRequest(http.MethodGet, "/dependency/issues?type=bogus", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusBadRequest, w.Code)
		assert.Contains(t, w.Body.String(), "invalid syntax")
	})
}

func TestHandleDependencyClearMetadata(t *testing.T) {
	t.Run("default dry run is true", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("ClearDependencyMetadata", mock.Anything,
			mock.MatchedBy(func(req *pb.ClearDependencyMetadataRequest) bool {
				return req.GetDryRun()
			}),
			mock.Anything,
		).Return(&pb.ClearDependencyMetadataResponse{UpdatedTaskCount: 2}, nil)

		router := setupDependencyHandlerRouter(mockDependency)
		req, _ := http.NewRequest(http.MethodPost, "/dependency/clear_metadata", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Body.String(), "\"updated_task_count\":2")
		mockDependency.AssertExpectations(t)
	})

	t.Run("explicit false dry run is passed through", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("ClearDependencyMetadata", mock.Anything,
			mock.MatchedBy(func(req *pb.ClearDependencyMetadataRequest) bool {
				return !req.GetDryRun()
			}),
			mock.Anything,
		).Return(&pb.ClearDependencyMetadataResponse{}, nil)

		router := setupDependencyHandlerRouter(mockDependency)
		req, _ := http.NewRequest(http.MethodPost, "/dependency/clear_metadata?dry_run=false", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		mockDependency.AssertExpectations(t)
	})

	t.Run("deadline exceeded maps to gateway timeout", func(t *testing.T) {
		mockDependency := new(mocks.MockDependencyServiceClient)
		mockDependency.On("ClearDependencyMetadata", mock.Anything, mock.Anything, mock.Anything).
			Return(nil, status.Error(codes.DeadlineExceeded, "clear metadata timed out"))

		router := setupDependencyHandlerRouter(mockDependency)
		req, _ := http.NewRequest(http.MethodPost, "/dependency/clear_metadata?dry_run=false", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusGatewayTimeout, w.Code)
		assert.Contains(t, w.Body.String(), "timed out")
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
