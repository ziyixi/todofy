package main

import (
	"encoding/json"
	"errors"
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
) (*httptest.ResponseRecorder, *gin.Engine) {
	gin.SetMode(gin.TestMode)

	clients := mocks.NewMockGRPCClients()
	clients.SetClient("database", mockDB)
	if mockLLM != nil {
		clients.SetClient("llm", mockLLM)
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

	w, router := setupSummaryTest(mockDB, mockLLM)
	req, _ := http.NewRequest(http.MethodGet, "/api/summary", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var body map[string]any
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, "Today you had a project deadline email and a standup meeting.", body["summary"])
	assert.EqualValues(t, 2, body["task_count"])
	assert.EqualValues(t, 24, body["time_window_hours"])

	mockDB.AssertExpectations(t)
	mockLLM.AssertExpectations(t)
}

func TestHandleSummary_SuccessNoEntries(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{Entries: []*pb.DataBaseSchema{}}, nil)

	w, router := setupSummaryTest(mockDB, nil)
	req, _ := http.NewRequest(http.MethodGet, "/api/summary", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var body map[string]any
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Contains(t, body["summary"], "no new task in the last 24 hours")
	assert.EqualValues(t, 0, body["task_count"])
	assert.EqualValues(t, 24, body["time_window_hours"])

	mockDB.AssertExpectations(t)
}

func TestHandleSummary_DatabaseError(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("db connection refused"))

	w, router := setupSummaryTest(mockDB, nil)
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

	w, router := setupSummaryTest(mockDB, mockLLM)
	req, _ := http.NewRequest(http.MethodGet, "/api/summary", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "llm quota exceeded")
	mockDB.AssertExpectations(t)
	mockLLM.AssertExpectations(t)
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

	w, router := setupSummaryTest(mockDB, mockLLM)
	req, _ := http.NewRequest(http.MethodGet, "/api/summary", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var body map[string]any
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, "Combined summary of alpha, beta, gamma.", body["summary"])
	assert.EqualValues(t, 3, body["task_count"])
	assert.EqualValues(t, 24, body["time_window_hours"])

	mockLLM.AssertExpectations(t)
}
