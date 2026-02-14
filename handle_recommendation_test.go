package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"github.com/ziyixi/todofy/testutils/mocks"
	"github.com/ziyixi/todofy/utils"

	pb "github.com/ziyixi/protos/go/todofy"
)

// helper to set up a gin test context with mock clients injected.
func setupRecommendationTest(
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
	router.GET("/api/recommendation", HandleRecommendation)

	w := httptest.NewRecorder()
	return w, router
}

func TestTimeDurationToRecommendation(t *testing.T) {
	t.Run("constant has correct value", func(t *testing.T) {
		expected := 24 * time.Hour
		assert.Equal(t, expected, TimeDurationToRecommendation)
	})
}

func TestHandleRecommendation_NoTasks(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{Entries: []*pb.DataBaseSchema{}}, nil)

	w, router := setupRecommendationTest(mockDB, nil)
	req, _ := http.NewRequest(http.MethodGet, "/api/recommendation", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp RecommendationResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, 0, resp.TaskCount)
	assert.Empty(t, resp.Tasks)
	assert.Empty(t, resp.Model)
	mockDB.AssertExpectations(t)
}

func TestHandleRecommendation_DatabaseError(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("db connection refused"))

	w, router := setupRecommendationTest(mockDB, nil)
	req, _ := http.NewRequest(http.MethodGet, "/api/recommendation", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "db connection refused")
	mockDB.AssertExpectations(t)
}

func TestHandleRecommendation_LLMError(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{
			Entries: []*pb.DataBaseSchema{{Summary: "task A"}},
		}, nil)

	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("llm quota exceeded"))

	w, router := setupRecommendationTest(mockDB, mockLLM)
	req, _ := http.NewRequest(http.MethodGet, "/api/recommendation", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "llm quota exceeded")
	mockDB.AssertExpectations(t)
	mockLLM.AssertExpectations(t)
}

func TestHandleRecommendation_ValidJSON(t *testing.T) {
	llmJSON := `[{"rank":1,"title":"重要任务A","reason":"需要立即处理"},` +
		`{"rank":2,"title":"任务B","reason":"截止日期临近"},` +
		`{"rank":3,"title":"任务C","reason":"团队在等待"}]`

	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{
			Entries: []*pb.DataBaseSchema{
				{Summary: "task A"},
				{Summary: "task B"},
				{Summary: "task C"},
				{Summary: "task D"},
			},
		}, nil)

	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: llmJSON,
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		}, nil)

	w, router := setupRecommendationTest(mockDB, mockLLM)
	req, _ := http.NewRequest(http.MethodGet, "/api/recommendation", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp RecommendationResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, 4, resp.TaskCount)
	assert.Equal(t, "MODEL_GEMINI_2_5_FLASH_LITE", resp.Model)
	require.Len(t, resp.Tasks, 3)

	// Verify each task has the correct rank, title, and reason
	assert.Equal(t, 1, resp.Tasks[0].Rank)
	assert.Equal(t, "重要任务A", resp.Tasks[0].Title)
	assert.Equal(t, "需要立即处理", resp.Tasks[0].Reason)

	assert.Equal(t, 2, resp.Tasks[1].Rank)
	assert.Equal(t, "任务B", resp.Tasks[1].Title)
	assert.Equal(t, "截止日期临近", resp.Tasks[1].Reason)

	assert.Equal(t, 3, resp.Tasks[2].Rank)
	assert.Equal(t, "任务C", resp.Tasks[2].Title)
	assert.Equal(t, "团队在等待", resp.Tasks[2].Reason)

	mockDB.AssertExpectations(t)
	mockLLM.AssertExpectations(t)
}

func TestHandleRecommendation_JSONWithCodeFences(t *testing.T) {
	// LLMs sometimes wrap JSON in markdown code fences
	llmJSON := "```json\n" +
		`[{"rank":1,"title":"A","reason":"R1"},` +
		`{"rank":2,"title":"B","reason":"R2"},` +
		`{"rank":3,"title":"C","reason":"R3"}]` +
		"\n```"

	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{
			Entries: []*pb.DataBaseSchema{{Summary: "task"}},
		}, nil)

	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: llmJSON,
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH,
		}, nil)

	w, router := setupRecommendationTest(mockDB, mockLLM)
	req, _ := http.NewRequest(http.MethodGet, "/api/recommendation", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp RecommendationResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Len(t, resp.Tasks, 3)
	assert.Equal(t, 1, resp.Tasks[0].Rank)
	assert.Equal(t, 2, resp.Tasks[1].Rank)
	assert.Equal(t, 3, resp.Tasks[2].Rank)
}

func TestHandleRecommendation_PlainCodeFences(t *testing.T) {
	// Some LLMs use ``` without "json"
	llmJSON := "```\n" + `[{"rank":1,"title":"X","reason":"Y"}]` + "\n```"

	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{
			Entries: []*pb.DataBaseSchema{{Summary: "task"}},
		}, nil)

	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: llmJSON,
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH,
		}, nil)

	w, router := setupRecommendationTest(mockDB, mockLLM)
	req, _ := http.NewRequest(http.MethodGet, "/api/recommendation", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp RecommendationResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Len(t, resp.Tasks, 1)
	assert.Equal(t, 1, resp.Tasks[0].Rank)
	assert.Equal(t, "X", resp.Tasks[0].Title)
}

func TestHandleRecommendation_FallbackOnInvalidJSON(t *testing.T) {
	// LLM returns plain text instead of JSON
	plainText := "#1 重要任务\n说明...\n#2 另一个任务\n说明..."

	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{
			Entries: []*pb.DataBaseSchema{{Summary: "task"}},
		}, nil)

	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: plainText,
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH,
		}, nil)

	w, router := setupRecommendationTest(mockDB, mockLLM)
	req, _ := http.NewRequest(http.MethodGet, "/api/recommendation", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp RecommendationResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	// Fallback: single entry with rank 1
	require.Len(t, resp.Tasks, 1)
	assert.Equal(t, 1, resp.Tasks[0].Rank)
	assert.Equal(t, "recommendation", resp.Tasks[0].Title)
	assert.Equal(t, plainText, resp.Tasks[0].Reason)
	assert.Equal(t, 1, resp.TaskCount)
}

func TestHandleRecommendation_RanksArePreservedFromLLM(t *testing.T) {
	// Verify ranks come from LLM output, not hardcoded
	llmJSON := `[{"rank":1,"title":"T1","reason":"R1"},` +
		`{"rank":2,"title":"T2","reason":"R2"},` +
		`{"rank":3,"title":"T3","reason":"R3"}]`

	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{
			Entries: []*pb.DataBaseSchema{{Summary: "a"}, {Summary: "b"}},
		}, nil)

	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: llmJSON,
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		}, nil)

	w, router := setupRecommendationTest(mockDB, mockLLM)
	req, _ := http.NewRequest(http.MethodGet, "/api/recommendation", nil)
	router.ServeHTTP(w, req)

	var resp RecommendationResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Len(t, resp.Tasks, 3)

	// Ranks 1,2,3 — not all 1
	ranks := []int{resp.Tasks[0].Rank, resp.Tasks[1].Rank, resp.Tasks[2].Rank}
	assert.Equal(t, []int{1, 2, 3}, ranks, "ranks should be 1,2,3 from LLM, not all hardcoded to 1")
}

func TestHandleRecommendation_VerifiesPromptSent(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{
			Entries: []*pb.DataBaseSchema{
				{Summary: "summary1"},
				{Summary: "summary2"},
			},
		}, nil)

	expectedPrompt := fmt.Sprintf(
		utils.DefaultPromptToRecommendTopTasks,
		DefaultTopN, DefaultTopN, DefaultTopN, DefaultTopN,
	)
	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockLLM.On("Summarize", mock.Anything, mock.MatchedBy(func(req *pb.LLMSummaryRequest) bool {
		return req.Prompt == expectedPrompt &&
			req.ModelFamily == pb.ModelFamily_MODEL_FAMILY_GEMINI &&
			// The text should contain both summaries
			assert.Contains(t, req.Text, "summary1") &&
			assert.Contains(t, req.Text, "summary2")
	}), mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: `[{"rank":1,"title":"T","reason":"R"}]`,
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH,
		}, nil)

	w, router := setupRecommendationTest(mockDB, mockLLM)
	req, _ := http.NewRequest(http.MethodGet, "/api/recommendation", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	mockLLM.AssertExpectations(t)
}

func TestHandleRecommendation_TaskCountMatchesDBEntries(t *testing.T) {
	// task_count should reflect DB entries, not parsed tasks
	llmJSON := `[{"rank":1,"title":"T1","reason":"R1"},` +
		`{"rank":2,"title":"T2","reason":"R2"},` +
		`{"rank":3,"title":"T3","reason":"R3"}]`

	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{
			Entries: []*pb.DataBaseSchema{
				{Summary: "a"},
				{Summary: "b"},
				{Summary: "c"},
				{Summary: "d"},
				{Summary: "e"},
			},
		}, nil)

	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: llmJSON,
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH,
		}, nil)

	w, router := setupRecommendationTest(mockDB, mockLLM)
	req, _ := http.NewRequest(http.MethodGet, "/api/recommendation", nil)
	router.ServeHTTP(w, req)

	var resp RecommendationResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, 5, resp.TaskCount,
		"task_count should be number of DB entries (5), not number of recommendations (3)")
	assert.Len(t, resp.Tasks, 3)
}

func TestHandleRecommendation_EmptyStringFromLLM(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{
			Entries: []*pb.DataBaseSchema{{Summary: "task"}},
		}, nil)

	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: "",
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH,
		}, nil)

	w, router := setupRecommendationTest(mockDB, mockLLM)
	req, _ := http.NewRequest(http.MethodGet, "/api/recommendation", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp RecommendationResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	// Empty string is invalid JSON array, should trigger fallback
	require.Len(t, resp.Tasks, 1)
	assert.Equal(t, 1, resp.Tasks[0].Rank)
	assert.Equal(t, "recommendation", resp.Tasks[0].Title)
}

func TestHandleRecommendation_TopParamCustomValue(t *testing.T) {
	llmJSON := `[{"rank":1,"title":"T1","reason":"R1"},` +
		`{"rank":2,"title":"T2","reason":"R2"},` +
		`{"rank":3,"title":"T3","reason":"R3"},` +
		`{"rank":4,"title":"T4","reason":"R4"},` +
		`{"rank":5,"title":"T5","reason":"R5"}]`

	mockDB := new(mocks.MockDataBaseServiceClient)
	mockDB.On("QueryRecent", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.QueryRecentResponse{
			Entries: []*pb.DataBaseSchema{{Summary: "a"}},
		}, nil)

	expectedPrompt := fmt.Sprintf(
		utils.DefaultPromptToRecommendTopTasks, 5, 5, 5, 5,
	)
	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockLLM.On("Summarize", mock.Anything,
		mock.MatchedBy(func(req *pb.LLMSummaryRequest) bool {
			return req.Prompt == expectedPrompt
		}), mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: llmJSON,
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH,
		}, nil)

	w, router := setupRecommendationTest(mockDB, mockLLM)
	req, _ := http.NewRequest(
		http.MethodGet, "/api/recommendation?top=5", nil,
	)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp RecommendationResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Len(t, resp.Tasks, 5)
	assert.Equal(t, 5, resp.Tasks[4].Rank)
	mockLLM.AssertExpectations(t)
}

func TestHandleRecommendation_TopParamInvalid(t *testing.T) {
	tests := []struct {
		name  string
		query string
	}{
		{"zero", "?top=0"},
		{"negative", "?top=-1"},
		{"exceeds max", "?top=11"},
		{"non-numeric", "?top=abc"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockDB := new(mocks.MockDataBaseServiceClient)
			w, router := setupRecommendationTest(mockDB, nil)
			req, _ := http.NewRequest(
				http.MethodGet,
				"/api/recommendation"+tt.query,
				nil,
			)
			router.ServeHTTP(w, req)

			assert.Equal(t, http.StatusBadRequest, w.Code)
			assert.Contains(t, w.Body.String(), "invalid top")
		})
	}
}

func TestHandleRecommendation_TopParamBoundary(t *testing.T) {
	// top=1 and top=10 should both be accepted
	for _, topVal := range []string{"1", "10"} {
		t.Run("top="+topVal, func(t *testing.T) {
			mockDB := new(mocks.MockDataBaseServiceClient)
			mockDB.On("QueryRecent",
				mock.Anything, mock.Anything, mock.Anything).
				Return(&pb.QueryRecentResponse{
					Entries: []*pb.DataBaseSchema{},
				}, nil)

			w, router := setupRecommendationTest(mockDB, nil)
			req, _ := http.NewRequest(
				http.MethodGet,
				"/api/recommendation?top="+topVal,
				nil,
			)
			router.ServeHTTP(w, req)

			assert.Equal(t, http.StatusOK, w.Code)
		})
	}
}
