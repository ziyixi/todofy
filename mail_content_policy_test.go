package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"github.com/ziyixi/todofy/testutils/mocks"

	pb "github.com/ziyixi/protos/go/todofy"
)

func mailPolicyPayload(t *testing.T, fields map[string]any) []byte {
	t.Helper()
	var event map[string]any
	require.NoError(t, json.Unmarshal(testMailPayload("Synthetic policy test"), &event))
	for key, value := range fields {
		event["message"].(map[string]any)[key] = value
	}
	raw, err := json.Marshal(event)
	require.NoError(t, err)
	return raw
}

const (
	originalTextBytesField = "original_text_bytes"
	policyTextField        = "text"
	policyTruncatedField   = "text_truncated"
	policyTextFixture      = "中文🙂"
)

func TestMailContentPolicyMetadataCompatibility(t *testing.T) {
	_, err := parseMailReceivedEvent(testMailPayload("Legacy frozen event"))
	require.NoError(t, err)
	valid := map[string]any{
		policyTextField: policyTextFixture, policyTruncatedField: true, originalTextBytesField: 300_000,
		"html_omitted": true, "attachments_omitted_count": 2, "content_policy_version": "storage-v1",
		"attachments": []map[string]any{{"filename": "large.bin", "content_type": "application/octet-stream",
			"size": 3 << 20, "storage_status": "omitted", "omitted_reason": "size_limit"}}}
	event, err := parseMailReceivedEvent(mailPolicyPayload(t, valid))
	require.NoError(t, err)
	require.True(t, event.Message.TextTruncated)
	require.Equal(t, int64(300_000), *event.Message.OriginalTextBytes)
	require.Equal(t, "omitted", event.Message.Attachments[0].StorageStatus)
	for _, invalid := range []map[string]any{
		{policyTruncatedField: true},
		{policyTextField: policyTextFixture, policyTruncatedField: true, originalTextBytesField: 10},
		{policyTextField: policyTextFixture, originalTextBytesField: 9},
		{policyTextField: policyTextFixture, originalTextBytesField: 11},
		{"attachments_omitted_count": -1},
	} {
		_, err = parseMailReceivedEvent(mailPolicyPayload(t, invalid))
		require.Error(t, err)
	}
}

func TestMailTruncatedBodyNoticeSurvivesSummaryAndTask(t *testing.T) {
	_, inbox := mailInboxFixture(t)
	defer func() { _ = inbox.Close() }()
	router := gin.New()
	router.POST("/hooks/mail", inbox.handleWebhook)
	raw := mailPolicyPayload(t, map[string]any{
		policyTextField: policyTextFixture, policyTruncatedField: true, originalTextBytesField: 300_000,
	})
	require.Equal(t, http.StatusNoContent, mailWebhookRequest(router, raw, strings.Repeat("t", 48), testMailEventID))
	clients := mocks.NewMockGRPCClients()
	llm := new(mocks.MockLLMSummaryServiceClient)
	todo := new(mocks.MockTodoServiceClient)
	db := new(mocks.MockDataBaseServiceClient)
	clients.SetClient("llm", llm)
	clients.SetClient("todo", todo)
	clients.SetClient("database", db)
	llm.On("Summarize", mock.Anything, mock.MatchedBy(func(req *pb.LLMSummaryRequest) bool {
		return strings.Contains(req.Text, "正文不完整") && strings.Contains(req.Text, policyTextFixture)
	}), mock.Anything).Return(&pb.LLMSummaryResponse{Summary: testMailSummary}, nil).Once()
	todo.On("PopulateTodo", mock.Anything, mock.MatchedBy(func(req *pb.TodoRequest) bool {
		return strings.Contains(req.Body, "正文不完整") && strings.Contains(req.Body, testMailSummary)
	}), mock.Anything).Return(&pb.TodoResponse{Id: testMailTaskID}, nil).Once()
	db.On("Write", mock.Anything, mock.MatchedBy(func(req *pb.WriteRequest) bool {
		return strings.Contains(req.Schema.Summary, "正文不完整")
	}), mock.Anything).Return(&pb.WriteResponse{}, nil).Once()
	for range 3 {
		processed, err := inbox.processOne(context.Background(), clients)
		require.NoError(t, err)
		require.True(t, processed)
	}
	llm.AssertExpectations(t)
	todo.AssertExpectations(t)
	db.AssertExpectations(t)
}

func TestMailNeedsReviewIsDurableAndCannotRetryIntoBusinessSideEffects(t *testing.T) {
	for name, fields := range map[string]map[string]any{
		"explicit review":           {"needs_review": true},
		"omitted HTML without text": {"html_omitted": true, policyTextField: ""},
	} {
		t.Run(name, func(t *testing.T) {
			_, inbox := mailInboxFixture(t)
			defer func() { _ = inbox.Close() }()
			router := gin.New()
			router.POST("/hooks/mail", inbox.handleWebhook)
			router.POST("/api/v1/mail_inbox/:event_id/reconcile",
				gin.BasicAuth(gin.Accounts{"owner": "test-password"}), inbox.handleReconcile)
			raw := mailPolicyPayload(t, fields)
			require.Equal(t, http.StatusNoContent, mailWebhookRequest(router, raw, strings.Repeat("t", 48), testMailEventID))
			clients := mocks.NewMockGRPCClients() // No LLM or Todoist clients: neither may be consulted.
			processed, err := inbox.processOne(context.Background(), clients)
			require.NoError(t, err)
			require.True(t, processed)
			var state, code string
			var saved []byte
			require.NoError(t, inbox.db.QueryRow(`SELECT state,last_error_code,payload FROM mail_inbox_events`).
				Scan(&state, &code, &saved))
			require.Equal(t, "failed_summary", state)
			require.Equal(t, "mail_needs_review", code)
			require.Equal(t, raw, saved)
			require.Equal(t, http.StatusNoContent, mailWebhookRequest(router, raw, strings.Repeat("t", 48), testMailEventID))
			req := httptest.NewRequest(http.MethodPost, "/api/v1/mail_inbox/"+testMailEventID+"/reconcile",
				strings.NewReader(`{"event_id":"`+testMailEventID+`","resolution":"retry_summary"}`))
			req.SetBasicAuth("owner", "test-password")
			req.Header.Set("X-Todofy-Admin-Action", "reconcile-mail-inbox")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			require.Equal(t, http.StatusConflict, response.Code)
			processed, err = inbox.processOne(context.Background(), clients)
			require.NoError(t, err)
			require.False(t, processed)
		})
	}
}
