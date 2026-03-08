package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/ziyixi/todofy/testutils/mocks"
	"github.com/ziyixi/todofy/utils"

	pb "github.com/ziyixi/protos/go/todofy"
)

// helper to set up a gin test context with mock clients injected.
func setupUpdateTodoTest(
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
	router.POST("/api/updatetodo", HandleUpdateTodo)

	w := httptest.NewRecorder()
	return w, router
}

// validEmailJSON returns a CloudMailin-format JSON body with the given fields.
func validEmailJSON(from, to, subject, content string) string {
	return fmt.Sprintf(`{
		"headers": {"from": %q, "to": %q, "date": "2024-01-01", "subject": %q},
		"html": %q,
		"plain": %q
	}`, from, to, subject, "<p>"+content+"</p>", content)
}

// computeExpectedHash returns the SHA-256 hex hash of DefaultPromptToSummaryEmail + content,
// matching the logic in HandleUpdateTodo.
func computeExpectedHash(content string) string {
	hashInput := utils.DefaultPromptToSummaryEmail + content
	return fmt.Sprintf("%x", sha256.Sum256([]byte(hashInput)))
}

func TestHandleUpdateTodo_SuccessCacheMiss(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockTodo := new(mocks.MockTodoServiceClient)

	// CheckExist returns nil entry (cache miss)
	mockDB.On("CheckExist", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.CheckExistResponse{Entry: nil}, nil)

	// LLM summarizes
	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: "This is a test summary",
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH,
		}, nil)

	// Todo created
	mockTodo.On("PopulateTodo", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.TodoResponse{}, nil)

	// DB write succeeds
	mockDB.On("Write", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.WriteResponse{}, nil)

	w, router := setupUpdateTodoTest(mockDB, mockLLM, mockTodo)
	body := validEmailJSON("sender@example.com", "me@test.com", "Test Subject", "Test content")
	req, _ := http.NewRequest(http.MethodPost, "/api/updatetodo", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "todo created successfully")
	mockDB.AssertExpectations(t)
	mockLLM.AssertExpectations(t)
	mockTodo.AssertExpectations(t)
}

func TestHandleUpdateTodo_SuccessCacheHit(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockTodo := new(mocks.MockTodoServiceClient)

	// CheckExist returns a cached entry (cache hit) — LLM should NOT be called
	mockDB.On("CheckExist", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.CheckExistResponse{
			Entry: &pb.DataBaseSchema{
				Summary:     "Cached summary from DB",
				Model:       pb.Model_MODEL_GEMINI_2_5_FLASH,
				ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
				Prompt:      utils.DefaultPromptToSummaryEmail,
				Text:        "Test content",
			},
		}, nil)

	// Todo created
	mockTodo.On("PopulateTodo", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.TodoResponse{}, nil)

	// DB write succeeds
	mockDB.On("Write", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.WriteResponse{}, nil)

	// No LLM mock set — if handler calls LLM, it will panic (no "llm" client)
	w, router := setupUpdateTodoTest(mockDB, nil, mockTodo)
	body := validEmailJSON("sender@example.com", "me@test.com", "Test Subject", "Test content")
	req, _ := http.NewRequest(http.MethodPost, "/api/updatetodo", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "todo created successfully")
	mockDB.AssertExpectations(t)
	mockTodo.AssertExpectations(t)
}

func TestHandleUpdateTodo_InvalidBody(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)

	w, router := setupUpdateTodoTest(mockDB, nil, nil)
	// Send a non-JSON body that will parse to empty fields via gjson
	body := "this is not valid json at all"
	req, _ := http.NewRequest(http.MethodPost, "/api/updatetodo", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "from/to/subject/content is empty")
}

func TestHandleUpdateTodo_EmptyFields(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)

	w, router := setupUpdateTodoTest(mockDB, nil, nil)
	// Provide JSON with empty from and to
	body := validEmailJSON("", "", "Subject", "Content")
	req, _ := http.NewRequest(http.MethodPost, "/api/updatetodo", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "from/to/subject/content is empty")
}

func TestHandleUpdateTodo_SystemEmailPrefix(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)

	w, router := setupUpdateTodoTest(mockDB, nil, nil)
	subject := utils.SystemAutomaticallyEmailPrefix + " daily summary"
	body := validEmailJSON("sender@example.com", "me@test.com", subject, "Some content")
	req, _ := http.NewRequest(http.MethodPost, "/api/updatetodo", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "system automatically email")
}

func TestHandleUpdateTodo_CheckExistError(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockTodo := new(mocks.MockTodoServiceClient)

	// CheckExist fails — handler should log warning and proceed with LLM
	mockDB.On("CheckExist", mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("db connection refused"))

	// LLM summarizes (handler falls through to LLM path)
	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: "Summary after CheckExist failure",
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH,
		}, nil)

	mockTodo.On("PopulateTodo", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.TodoResponse{}, nil)

	mockDB.On("Write", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.WriteResponse{}, nil)

	w, router := setupUpdateTodoTest(mockDB, mockLLM, mockTodo)
	body := validEmailJSON("sender@example.com", "me@test.com", "Test Subject", "Test content")
	req, _ := http.NewRequest(http.MethodPost, "/api/updatetodo", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "todo created successfully")
	mockLLM.AssertExpectations(t)
	mockDB.AssertExpectations(t)
}

func TestHandleUpdateTodo_LLMError(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockLLM := new(mocks.MockLLMSummaryServiceClient)

	mockDB.On("CheckExist", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.CheckExistResponse{Entry: nil}, nil)

	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("llm quota exceeded"))

	w, router := setupUpdateTodoTest(mockDB, mockLLM, nil)
	body := validEmailJSON("sender@example.com", "me@test.com", "Test Subject", "Test content")
	req, _ := http.NewRequest(http.MethodPost, "/api/updatetodo", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "llm quota exceeded")
	mockDB.AssertExpectations(t)
	mockLLM.AssertExpectations(t)
}

func TestHandleUpdateTodo_TodoError(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockTodo := new(mocks.MockTodoServiceClient)

	mockDB.On("CheckExist", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.CheckExistResponse{Entry: nil}, nil)

	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: "A summary",
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH,
		}, nil)

	mockTodo.On("PopulateTodo", mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("todoist API down"))

	w, router := setupUpdateTodoTest(mockDB, mockLLM, mockTodo)
	body := validEmailJSON("sender@example.com", "me@test.com", "Test Subject", "Test content")
	req, _ := http.NewRequest(http.MethodPost, "/api/updatetodo", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "todoist API down")
	mockDB.AssertExpectations(t)
	mockLLM.AssertExpectations(t)
	mockTodo.AssertExpectations(t)
}

func TestHandleUpdateTodo_DBWriteError(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockTodo := new(mocks.MockTodoServiceClient)

	mockDB.On("CheckExist", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.CheckExistResponse{Entry: nil}, nil)

	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: "A summary",
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH,
		}, nil)

	mockTodo.On("PopulateTodo", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.TodoResponse{}, nil)

	mockDB.On("Write", mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("disk full"))

	w, router := setupUpdateTodoTest(mockDB, mockLLM, mockTodo)
	body := validEmailJSON("sender@example.com", "me@test.com", "Test Subject", "Test content")
	req, _ := http.NewRequest(http.MethodPost, "/api/updatetodo", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "disk full")
	mockDB.AssertExpectations(t)
	mockLLM.AssertExpectations(t)
	mockTodo.AssertExpectations(t)
}

func TestHandleUpdateTodo_TagRemoval(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockTodo := new(mocks.MockTodoServiceClient)

	mockDB.On("CheckExist", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.CheckExistResponse{Entry: nil}, nil)

	// Return a summary containing #tags that should be removed
	summaryWithTags := "Important task #urgent needs attention #review now"
	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: summaryWithTags,
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH,
		}, nil)

	// Capture the todo request to verify tags were removed from the description.
	// Note: html/template escapes < and > so <removed tag> becomes &lt;removed tag&gt;
	mockTodo.On("PopulateTodo", mock.Anything,
		mock.MatchedBy(func(req *pb.TodoRequest) bool {
			return (strings.Contains(req.Body, "<removed tag>") || strings.Contains(req.Body, "&lt;removed tag&gt;")) &&
				!strings.Contains(req.Body, "#urgent") &&
				!strings.Contains(req.Body, "#review")
		}), mock.Anything).
		Return(&pb.TodoResponse{}, nil)

	mockDB.On("Write", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.WriteResponse{}, nil)

	w, router := setupUpdateTodoTest(mockDB, mockLLM, mockTodo)
	body := validEmailJSON("sender@example.com", "me@test.com", "Test Subject", "Test content")
	req, _ := http.NewRequest(http.MethodPost, "/api/updatetodo", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	mockTodo.AssertExpectations(t)
}

func TestHandleUpdateTodo_HashConsistency(t *testing.T) {
	mockDB := new(mocks.MockDataBaseServiceClient)
	mockLLM := new(mocks.MockLLMSummaryServiceClient)
	mockTodo := new(mocks.MockTodoServiceClient)

	emailContent := "Test content for hash consistency"
	// The handler parses HTML via html-to-markdown; for simple <p>text</p> the
	// converted markdown is the plain text itself. Compute the expected hash
	// using the same content that ParseCloudmailin will produce.
	// We use plain text fallback to keep the test deterministic.
	emailBody := fmt.Sprintf(`{
		"headers": {"from": "sender@example.com", "to": "me@test.com", "date": "2024-01-01", "subject": "Hash Test"},
		"plain": %q
	}`, emailContent)
	// ParseCloudmailin falls back to plain when html is empty
	parsed := utils.ParseCloudmailin(emailBody)
	expectedHash := computeExpectedHash(parsed.Content)

	// Verify CheckExist receives the expected hash
	mockDB.On("CheckExist", mock.Anything,
		mock.MatchedBy(func(req *pb.CheckExistRequest) bool {
			return req.HashId == expectedHash
		}), mock.Anything).
		Return(&pb.CheckExistResponse{Entry: nil}, nil)

	mockLLM.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{
			Summary: "Summary",
			Model:   pb.Model_MODEL_GEMINI_2_5_FLASH,
		}, nil)

	mockTodo.On("PopulateTodo", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.TodoResponse{}, nil)

	// Verify Write receives the same hash
	mockDB.On("Write", mock.Anything,
		mock.MatchedBy(func(req *pb.WriteRequest) bool {
			return req.Schema != nil && req.Schema.HashId == expectedHash
		}), mock.Anything).
		Return(&pb.WriteResponse{}, nil)

	w, router := setupUpdateTodoTest(mockDB, mockLLM, mockTodo)
	req, _ := http.NewRequest(http.MethodPost, "/api/updatetodo", strings.NewReader(emailBody))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	mockDB.AssertExpectations(t)
}
