package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/ziyixi/todofy/testutils/mocks"
	"github.com/ziyixi/todofy/utils"

	pb "github.com/ziyixi/protos/go/todofy"
)

// helper to set up a gin test context with mock clients injected.
func setupSummaryTest(
	mockDB *mocks.MockDataBaseServiceClient,
	mockLLM *mocks.MockLLMSummaryServiceClient,
	mockTodo *mocks.MockTodoServiceClient,
) (*httptest.ResponseRecorder, *gin.Engine) {
	gin.SetMode(gin.TestMode)

	clients := mocks.NewMockGRPCClients()
	clients.SetClient("database", mockDB)
	if mockLLM != nil {
		clients.SetClient("llm", mockLLM)
	}
	if mockTodo != nil {
		clients.SetClient("todo", mockTodo)
	}

	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(utils.KeyGRPCClients, clients)
		c.Next()
	})
	router.GET("/api/summary", HandleSummary)

	w := httptest.NewRecorder()
	return w, router
}

func TestTimeDurationToSummary(t *testing.T) {
	t.Run("constant has correct value", func(t *testing.T) {
		expected := 24 * time.Hour
		assert.Equal(t, expected, TimeDurationToSummary)
	})
}

func TestHandleSummary_SuccessWithEntries(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{
			Entries: []*pb.DataBaseSchema{
				{Summary: "Email about project deadline"},
				{Summary: "Meeting notes from standup"},
			},
		}, nil)

	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: "Today you had a project deadline email and a standup meeting.",
		}, nil)

	mockTodo := new(mocks.MockTodoServiceClient)
	mockTodo.On("PopulateTodo", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.TodoResponse{}, nil)

	w, router := setupSummaryTest(mockDB, mockLLM, mockTodo)
	req, _ := http.NewRequest(http.MethodGet, "/api/summary", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "summary email sent successfully")
	mockDB.AssertExpectations(t)
	mockLLM.AssertExpectations(t)
	mockTodo.AssertExpectations(t)
}

func TestHandleSummary_SuccessNoEntries(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{Entries: []*pb.DataBaseSchema{}}, nil)

	mockTodo := new(mocks.MockTodoServiceClient)
	mockTodo.On("PopulateTodo", mock.Anything, mock.MatchedBy(func(req *pb.TodoRequest) bool {
		// When no entries, the body should be the default "no new task" message
		return assert.Contains(t, req.Body, "no new task in the last 24 hours") &&
			assert.Contains(t, req.Body, "no summary")
	}), mock.Anything).
		Return(&pb.TodoResponse{}, nil)

	w, router := setupSummaryTest(mockDB, nil, mockTodo)
	req, _ := http.NewRequest(http.MethodGet, "/api/summary", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "summary email sent successfully")
	mockDB.AssertExpectations(t)
	mockTodo.AssertExpectations(t)
}

func TestHandleSummary_DatabaseError(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("db connection refused"))

	w, router := setupSummaryTest(mockDB, nil, nil)
	req, _ := http.NewRequest(http.MethodGet, "/api/summary", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "db connection refused")
	mockDB.AssertExpectations(t)
}

func TestHandleSummary_LLMError(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{
			Entries: []*pb.DataBaseSchema{{Summary: "some task"}},
		}, nil)

	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("llm quota exceeded"))

	w, router := setupSummaryTest(mockDB, mockLLM, nil)
	req, _ := http.NewRequest(http.MethodGet, "/api/summary", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "llm quota exceeded")
	mockDB.AssertExpectations(t)
	mockLLM.AssertExpectations(t)
}

func TestHandleSummary_TodoError(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{
			Entries: []*pb.DataBaseSchema{{Summary: "task A"}},
		}, nil)

	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: "Summary of task A.",
		}, nil)

	mockTodo := new(mocks.MockTodoServiceClient)
	mockTodo.On("PopulateTodo", mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("mailjet service unavailable"))

	w, router := setupSummaryTest(mockDB, mockLLM, mockTodo)
	req, _ := http.NewRequest(http.MethodGet, "/api/summary", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "mailjet service unavailable")
	mockDB.AssertExpectations(t)
	mockLLM.AssertExpectations(t)
	mockTodo.AssertExpectations(t)
}

func TestHandleSummary_VerifiesPromptAndContent(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{
			Entries: []*pb.DataBaseSchema{
				{Summary: "summary_alpha"},
				{Summary: "summary_beta"},
				{Summary: "summary_gamma"},
			},
		}, nil)

	splitter := "=========================\n"
	expectedContent := splitter +
		"summary_alpha\n" + splitter +
		"summary_beta\n" + splitter +
		"summary_gamma\n" + splitter

	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockLLM.On("Summarize", mock.Anything, mock.MatchedBy(func(req *pb.LLMSummaryRequest) bool {
		return req.Prompt == utils.DefaultPromptToSummaryEmailRange &&
			req.ModelFamily == pb.ModelFamily_MODEL_FAMILY_GEMINI &&
			req.Text == expectedContent
	}), mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: "Combined summary of alpha, beta, gamma.",
		}, nil)

	mockTodo := new(mocks.MockTodoServiceClient)
	mockTodo.On("PopulateTodo", mock.Anything, mock.MatchedBy(func(req *pb.TodoRequest) bool {
		return req.Body == "Combined summary of alpha, beta, gamma."
	}), mock.Anything).
		Return(&pb.TodoResponse{}, nil)

	w, router := setupSummaryTest(mockDB, mockLLM, mockTodo)
	req, _ := http.NewRequest(http.MethodGet, "/api/summary", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	mockLLM.AssertExpectations(t)
	mockTodo.AssertExpectations(t)
}

func TestHandleSummary_VerifiesEmailFields(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{Entries: []*pb.DataBaseSchema{}}, nil)

	todayDate := time.Now().Format("2006-01-02")
	expectedSubject := utils.SystemAutomaticallyEmailPrefix +
		fmt.Sprintf("[%s] Summary of last 24 hours", todayDate)

	mockTodo := new(mocks.MockTodoServiceClient)
	mockTodo.On("PopulateTodo", mock.Anything, mock.MatchedBy(func(req *pb.TodoRequest) bool {
		return req.App == pb.TodoApp_TODO_APP_DIDA365 &&
			req.Method == pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET &&
			req.Subject == expectedSubject &&
			req.From == utils.SystemAutomaticallyEmailSender &&
			req.To == utils.SystemAutomaticallyEmailReceiver &&
			req.ToName == utils.SystemAutomaticallyEmailReceiverName
	}), mock.Anything).
		Return(&pb.TodoResponse{}, nil)

	w, router := setupSummaryTest(mockDB, nil, mockTodo)
	req, _ := http.NewRequest(http.MethodGet, "/api/summary", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	mockTodo.AssertExpectations(t)
}
