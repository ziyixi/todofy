package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"github.com/ziyixi/todofy/testutils/mocks"

	pb "github.com/ziyixi/protos/go/todofy"
)

const testMailSummary = "Synthetic summary"
const testMailTaskID = "synthetic-task-1"

const testMailEventID = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001"

func mailInboxFixture(t *testing.T) (Config, *mailInbox) {
	t.Helper()
	dir := t.TempDir()
	tokenFile := filepath.Join(dir, "token")
	require.NoError(t, os.WriteFile(tokenFile, []byte(strings.Repeat("t", 48)+"\n"), 0600))
	cfg := Config{
		MailInboxPath:        filepath.Join(dir, "inbox.sqlite"),
		MailWebhookTokenFile: tokenFile,
		MailSourceID:         "mail-hero-personal",
	}
	inbox, err := openMailInbox(cfg)
	require.NoError(t, err)
	return cfg, inbox
}

func testMailPayload(subject string) []byte {
	return []byte(`{"type":"mail.received.v1","event_id":"` + testMailEventID +
		`","received_at":"2026-09-23T16:00:00Z","message":{"id":"f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710002",` +
		`"from":[{"address":"sender@example.org","name":"Sender"}],"to":[],"subject":"` + subject +
		`","sent_at":null,"rfc_message_id":null,"text":"Synthetic mail body","attachments":[]}}`)
}

func mailWebhookRequest(router *gin.Engine, body []byte, token, eventID string) int {
	req := httptest.NewRequest(http.MethodPost, "/hooks/mail", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if eventID != "" {
		req.Header.Set("Idempotency-Key", eventID)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	return response.Code
}

func TestMailInboxWebhookDurableIdempotency(t *testing.T) {
	cfg, inbox := mailInboxFixture(t)
	router := gin.New()
	router.POST("/hooks/mail", inbox.handleWebhook)
	first := testMailPayload("Synthetic subject")
	token := strings.Repeat("t", 48)
	require.Equal(t, http.StatusUnauthorized, mailWebhookRequest(router, first, "", testMailEventID))
	require.Equal(t, http.StatusBadRequest, mailWebhookRequest(router, first, token, "wrong-id"))
	require.Equal(t, http.StatusNoContent, mailWebhookRequest(router, first, token, testMailEventID))
	require.Equal(t, http.StatusNoContent, mailWebhookRequest(router, first, token, testMailEventID))
	require.Equal(
		t,
		http.StatusConflict,
		mailWebhookRequest(router, testMailPayload("Changed subject"), token, testMailEventID),
	)
	var count int
	require.NoError(t, inbox.db.QueryRow(`SELECT count(*) FROM mail_inbox_events`).Scan(&count))
	require.Equal(t, 1, count)
	require.NoError(t, inbox.Close())

	reopened, err := openMailInbox(cfg)
	require.NoError(t, err)
	defer func() { _ = reopened.Close() }()
	router = gin.New()
	router.POST("/hooks/mail", reopened.handleWebhook)
	require.Equal(t, http.StatusNoContent, mailWebhookRequest(router, first, token, testMailEventID))
	require.NoError(t, reopened.db.QueryRow(`SELECT count(*) FROM mail_inbox_events`).Scan(&count))
	require.Equal(t, 1, count)
}

func TestMailInboxWorkerCompletesWithoutWebhookReexecution(t *testing.T) {
	_, inbox := mailInboxFixture(t)
	defer func() { _ = inbox.Close() }()
	router := gin.New()
	router.POST("/hooks/mail", inbox.handleWebhook)
	require.Equal(
		t,
		http.StatusNoContent,
		mailWebhookRequest(router, testMailPayload("Synthetic subject"), strings.Repeat("t", 48), testMailEventID),
	)

	clients := mocks.NewMockGRPCClients()
	llm := new(mocks.MockLLMSummaryServiceClient)
	todo := new(mocks.MockTodoServiceClient)
	db := new(mocks.MockDataBaseServiceClient)
	clients.SetClient("llm", llm)
	clients.SetClient("todo", todo)
	clients.SetClient("database", db)
	llm.On("Summarize", mock.Anything, mock.MatchedBy(func(req *pb.LLMSummaryRequest) bool {
		return req.Text == "Synthetic mail body"
	}), mock.Anything).Return(&pb.LLMSummaryResponse{Summary: testMailSummary}, nil).Once()
	todo.On("PopulateTodo", mock.Anything, mock.MatchedBy(func(req *pb.TodoRequest) bool {
		return req.Subject == "Synthetic subject" && strings.Contains(req.Body, testMailEventID)
	}), mock.Anything).Return(&pb.TodoResponse{Id: testMailTaskID}, nil).Once()
	db.On("Write", mock.Anything, mock.MatchedBy(func(req *pb.WriteRequest) bool {
		return req.Schema.Summary != "" && strings.HasPrefix(req.Schema.HashId, "mailhero-v1-")
	}), mock.Anything).Return(&pb.WriteResponse{}, nil).Once()
	for range 3 {
		processed, err := inbox.processOne(context.Background(), clients)
		require.NoError(t, err)
		require.True(t, processed)
	}
	processed, err := inbox.processOne(context.Background(), clients)
	require.NoError(t, err)
	require.False(t, processed)
	var state, taskID string
	require.NoError(t, inbox.db.QueryRow(`SELECT state,task_id FROM mail_inbox_events`).Scan(&state, &taskID))
	require.Equal(t, "complete", state)
	require.Equal(t, testMailTaskID, taskID)
	require.Equal(
		t,
		http.StatusNoContent,
		mailWebhookRequest(router, testMailPayload("Synthetic subject"), strings.Repeat("t", 48), testMailEventID),
	)
	processed, err = inbox.processOne(context.Background(), clients)
	require.NoError(t, err)
	require.False(t, processed)
	llm.AssertExpectations(t)
	todo.AssertExpectations(t)
	db.AssertExpectations(t)
}

func TestMailInboxUnknownTodoResultNeverAutoRetries(t *testing.T) {
	cfg, inbox := mailInboxFixture(t)
	router := gin.New()
	router.POST("/hooks/mail", inbox.handleWebhook)
	require.Equal(
		t,
		http.StatusNoContent,
		mailWebhookRequest(router, testMailPayload("Synthetic subject"), strings.Repeat("t", 48), testMailEventID),
	)
	clients := mocks.NewMockGRPCClients()
	llm := new(mocks.MockLLMSummaryServiceClient)
	todo := new(mocks.MockTodoServiceClient)
	clients.SetClient("llm", llm)
	clients.SetClient("todo", todo)
	llm.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{Summary: testMailSummary}, nil).Once()
	todo.On("PopulateTodo", mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("synthetic timeout after possible creation")).Once()
	processed, err := inbox.processOne(context.Background(), clients)
	require.NoError(t, err)
	require.True(t, processed)
	processed, err = inbox.processOne(context.Background(), clients)
	require.NoError(t, err)
	require.True(t, processed)
	for range 2 {
		processed, err = inbox.processOne(context.Background(), clients)
		require.NoError(t, err)
		require.False(t, processed)
	}
	var state string
	require.NoError(t, inbox.db.QueryRow(`SELECT state FROM mail_inbox_events`).Scan(&state))
	require.Equal(t, "todo_unknown", state)
	require.NoError(t, inbox.Close())
	reopened, err := openMailInbox(cfg)
	require.NoError(t, err)
	defer func() { _ = reopened.Close() }()
	processed, err = reopened.processOne(context.Background(), clients)
	require.NoError(t, err)
	require.False(t, processed)
	todo.AssertNumberOfCalls(t, "PopulateTodo", 1)
}

func TestMailInboxInterruptedTodoIsUnknownOnRestart(t *testing.T) {
	cfg, inbox := mailInboxFixture(t)
	defer func() { _ = inbox.Close() }()
	now := time.Now().Unix()
	_, err := inbox.db.Exec(
		`INSERT INTO mail_inbox_events(source_id,event_id,payload_hash,payload,state,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?)`,
		cfg.MailSourceID,
		testMailEventID,
		[]byte("hash"),
		testMailPayload("Synthetic subject"),
		"todo_sending",
		now,
		now,
	)
	require.NoError(t, err)
	require.NoError(t, inbox.Close())
	reopened, err := openMailInbox(cfg)
	require.NoError(t, err)
	defer func() { _ = reopened.Close() }()
	var state string
	require.NoError(t, reopened.db.QueryRow(`SELECT state FROM mail_inbox_events`).Scan(&state))
	require.Equal(t, "todo_unknown", state)
}

func TestMailInboxReconcileRequiresExplicitOwnerAction(t *testing.T) {
	_, inbox := mailInboxFixture(t)
	defer func() { _ = inbox.Close() }()
	now := time.Now().Unix()
	_, err := inbox.db.Exec(
		`INSERT INTO mail_inbox_events(source_id,event_id,payload_hash,payload,state,
		summary,todo_body,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?)`,
		inbox.sourceID,
		testMailEventID,
		[]byte("hash"),
		testMailPayload("Synthetic subject"),
		"todo_unknown",
		testMailSummary,
		"Synthetic task body",
		now,
		now,
	)
	require.NoError(t, err)
	router := gin.New()
	router.POST(
		"/api/v1/mail_inbox/:event_id/reconcile",
		gin.BasicAuth(gin.Accounts{"owner": "test-password"}),
		inbox.handleReconcile,
	)
	call := func(auth, header, body string) int {
		req := httptest.NewRequest(
			http.MethodPost,
			"/api/v1/mail_inbox/"+testMailEventID+"/reconcile",
			strings.NewReader(body),
		)
		if auth != "" {
			req.SetBasicAuth("owner", auth)
		}
		if header != "" {
			req.Header.Set("X-Todofy-Admin-Action", header)
		}
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		return resp.Code
	}
	body := `{"event_id":"` + testMailEventID +
		`","resolution":"task_created","task_id":"` + testMailTaskID + `"}`
	require.Equal(t, http.StatusUnauthorized, call("", "reconcile-mail-inbox", body))
	require.Equal(t, http.StatusForbidden, call("test-password", "", body))
	require.Equal(t, http.StatusNoContent, call("test-password", "reconcile-mail-inbox", body))
	require.Equal(t, http.StatusConflict, call("test-password", "reconcile-mail-inbox", body))
	var state, taskID string
	require.NoError(t, inbox.db.QueryRow(`SELECT state,task_id FROM mail_inbox_events`).Scan(&state, &taskID))
	require.Equal(t, "todo_created", state)
	require.Equal(t, testMailTaskID, taskID)
}

func TestMailInboxRejectsSourceIDChangeAndPartialConfig(t *testing.T) {
	cfg, inbox := mailInboxFixture(t)
	router := gin.New()
	router.POST("/hooks/mail", inbox.handleWebhook)
	require.Equal(
		t,
		http.StatusNoContent,
		mailWebhookRequest(router, testMailPayload("Synthetic subject"), strings.Repeat("t", 48), testMailEventID),
	)
	require.NoError(t, inbox.Close())
	cfg.MailSourceID = "different-mail-hero"
	_, err := openMailInbox(cfg)
	require.ErrorContains(t, err, "source ID differs")
	require.Error(t, validateMailInboxConfig(Config{MailInboxPath: cfg.MailInboxPath}))
}

func TestMailInboxRejectsIncompleteContract(t *testing.T) {
	_, inbox := mailInboxFixture(t)
	defer func() { _ = inbox.Close() }()
	router := gin.New()
	router.POST("/hooks/mail", inbox.handleWebhook)
	missingAttachments := bytes.Replace(testMailPayload("Synthetic subject"), []byte(`,"attachments":[]`), nil, 1)
	require.Equal(
		t,
		http.StatusBadRequest,
		mailWebhookRequest(router, missingAttachments, strings.Repeat("t", 48), testMailEventID),
	)
	var count int
	require.NoError(t, inbox.db.QueryRow(`SELECT count(*) FROM mail_inbox_events`).Scan(&count))
	require.Zero(t, count)
}

func TestMailInboxUnavailableTodoClientStaysRetryableBeforeCall(t *testing.T) {
	_, inbox := mailInboxFixture(t)
	defer func() { _ = inbox.Close() }()
	router := gin.New()
	router.POST("/hooks/mail", inbox.handleWebhook)
	require.Equal(
		t,
		http.StatusNoContent,
		mailWebhookRequest(router, testMailPayload("Synthetic subject"), strings.Repeat("t", 48), testMailEventID),
	)
	clients := mocks.NewMockGRPCClients()
	llm := new(mocks.MockLLMSummaryServiceClient)
	clients.SetClient("llm", llm)
	llm.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{Summary: testMailSummary}, nil).Once()
	processed, err := inbox.processOne(context.Background(), clients)
	require.NoError(t, err)
	require.True(t, processed)
	processed, err = inbox.processOne(context.Background(), clients)
	require.NoError(t, err)
	require.True(t, processed)
	var state, code string
	var next int64
	require.NoError(
		t,
		inbox.db.QueryRow(`SELECT state,last_error_code,next_attempt_at FROM mail_inbox_events`).
			Scan(&state, &code, &next),
	)
	require.Equal(t, "summarized", state)
	require.Equal(t, "todo_client_unavailable", code)
	require.Greater(t, next, time.Now().Unix())
	processed, err = inbox.processOne(context.Background(), clients)
	require.NoError(t, err)
	require.False(t, processed)

	todo := new(mocks.MockTodoServiceClient)
	clients.SetClient("todo", todo)
	todo.On("PopulateTodo", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.TodoResponse{Id: testMailTaskID}, nil).Once()
	_, err = inbox.db.Exec(`UPDATE mail_inbox_events SET next_attempt_at=0`)
	require.NoError(t, err)
	processed, err = inbox.processOne(context.Background(), clients)
	require.NoError(t, err)
	require.True(t, processed)
	require.NoError(t, inbox.db.QueryRow(`SELECT state FROM mail_inbox_events`).Scan(&state))
	require.Equal(t, "todo_created", state)
	todo.AssertNumberOfCalls(t, "PopulateTodo", 1)
}

func TestMailInboxBodyOnlyMessageGetsNonemptyTodoTitle(t *testing.T) {
	_, inbox := mailInboxFixture(t)
	defer func() { _ = inbox.Close() }()
	router := gin.New()
	router.POST("/hooks/mail", inbox.handleWebhook)
	payload := testMailPayload("   ")
	require.Equal(
		t,
		http.StatusNoContent,
		mailWebhookRequest(router, payload, strings.Repeat("t", 48), testMailEventID),
	)

	clients := mocks.NewMockGRPCClients()
	llm := new(mocks.MockLLMSummaryServiceClient)
	todo := new(mocks.MockTodoServiceClient)
	clients.SetClient("llm", llm)
	clients.SetClient("todo", todo)
	llm.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.LLMSummaryResponse{Summary: testMailSummary}, nil).Once()
	todo.On("PopulateTodo", mock.Anything, mock.MatchedBy(func(req *pb.TodoRequest) bool {
		return req.Subject == "(No subject)" && strings.Contains(req.Body, testMailEventID)
	}), mock.Anything).Return(&pb.TodoResponse{Id: testMailTaskID}, nil).Once()
	for range 2 {
		processed, err := inbox.processOne(context.Background(), clients)
		require.NoError(t, err)
		require.True(t, processed)
	}
	var state string
	var savedPayload []byte
	require.NoError(t, inbox.db.QueryRow(`SELECT state,payload FROM mail_inbox_events`).Scan(&state, &savedPayload))
	require.Equal(t, "todo_created", state)
	require.Equal(t, payload, savedPayload)
	todo.AssertExpectations(t)
}

func TestMailInboxTokenRotationKeepsDeduplicationAndSingleWriter(t *testing.T) {
	cfg, inbox := mailInboxFixture(t)
	defer func() { _ = inbox.Close() }()
	second, err := openMailInbox(cfg)
	require.ErrorContains(t, err, "already open")
	require.Nil(t, second)
	router := gin.New()
	router.POST("/hooks/mail", inbox.handleWebhook)
	payload := testMailPayload("Synthetic subject")
	require.Equal(
		t,
		http.StatusNoContent,
		mailWebhookRequest(router, payload, strings.Repeat("t", 48), testMailEventID),
	)
	require.NoError(t, os.WriteFile(cfg.MailWebhookTokenFile, []byte(strings.Repeat("r", 48)), 0600))
	require.Equal(
		t,
		http.StatusUnauthorized,
		mailWebhookRequest(router, payload, strings.Repeat("t", 48), testMailEventID),
	)
	require.Equal(
		t,
		http.StatusNoContent,
		mailWebhookRequest(router, payload, strings.Repeat("r", 48), testMailEventID),
	)
	var count int
	require.NoError(t, inbox.db.QueryRow(`SELECT count(*) FROM mail_inbox_events`).Scan(&count))
	require.Equal(t, 1, count)
}
