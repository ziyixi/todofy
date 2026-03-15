package tests

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	pb "github.com/ziyixi/protos/go/todofy"
	admincontract "github.com/ziyixi/todofy/sut/contracts/admin"
	geminicontract "github.com/ziyixi/todofy/sut/contracts/gemini"
	"github.com/ziyixi/todofy/utils"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

type harness struct {
	baseURL         string
	geminiAdminURL  string
	todoistAdminURL string
	username        string
	password        string
	webhookSecret   string
	httpClient      *http.Client
	dbConn          *grpc.ClientConn
	dbClient        pb.DataBaseServiceClient
}

// newHarness connects to the already-running docker-compose SUT stack.
// Tests use this instead of in-process setup so they exercise the real HTTP/gRPC wiring.
func newHarness(t *testing.T) *harness {
	t.Helper()

	conn, err := grpc.NewClient(
		envOrDefault("TODOFY_SUT_DATABASE_ADDR", "localhost:10053"),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)

	return &harness{
		baseURL:         envOrDefault("TODOFY_SUT_BASE_URL", "http://localhost:10013"),
		geminiAdminURL:  envOrDefault("TODOFY_SUT_GEMINI_ADMIN_URL", "http://localhost:18081"),
		todoistAdminURL: envOrDefault("TODOFY_SUT_TODOIST_ADMIN_URL", "http://localhost:18082"),
		username:        envOrDefault("TODOFY_SUT_ALLOWED_USER", "sutuser"),
		password:        envOrDefault("TODOFY_SUT_ALLOWED_PASSWORD", "sutpassword"),
		webhookSecret:   envOrDefault("TODOFY_SUT_WEBHOOK_SECRET", "sut-webhook-secret"),
		httpClient: &http.Client{
			Timeout: 20 * time.Second,
		},
		dbConn:   conn,
		dbClient: pb.NewDataBaseServiceClient(conn),
	}
}

func (h *harness) Close() {
	if h.dbConn != nil {
		_ = h.dbConn.Close()
	}
}

func (h *harness) resetScenario(t *testing.T) {
	t.Helper()

	// Reset both fake providers and move the database client to a fresh SQLite file.
	// That keeps subtests isolated without restarting the whole compose stack.
	h.postJSON(t, h.geminiAdminURL+"/admin/reset", nil)
	h.postJSON(t, h.todoistAdminURL+"/admin/reset", nil)
	h.resetDatabase(t)
}

func (h *harness) resetDatabase(t *testing.T) string {
	t.Helper()

	path := fmt.Sprintf("/tmp/%s-%d.db", sanitizeName(t.Name()), time.Now().UnixNano())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := h.dbClient.CreateIfNotExist(ctx, &pb.CreateIfNotExistRequest{
		Type: pb.DatabaseType_DATABASE_TYPE_SQLITE,
		Path: path,
	})
	require.NoError(t, err)
	return path
}

func (h *harness) writeEntry(t *testing.T, schema *pb.DataBaseSchema) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := h.dbClient.Write(ctx, &pb.WriteRequest{
		Type:   pb.DatabaseType_DATABASE_TYPE_SQLITE,
		Schema: schema,
	})
	require.NoError(t, err)
}

func (h *harness) queryEntries(t *testing.T) []*pb.DataBaseSchema {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := h.dbClient.QueryRecent(ctx, &pb.QueryRecentRequest{
		Type:             pb.DatabaseType_DATABASE_TYPE_SQLITE,
		TimeAgoInSeconds: int64((30 * 24 * time.Hour).Seconds()),
	})
	require.NoError(t, err)
	return resp.GetEntries()
}

func (h *harness) seedGemini(t *testing.T, req admincontract.SeedGeminiStateRequest) {
	t.Helper()
	// Admin endpoints control fake behavior directly; vendor-shaped endpoints stay reserved
	// for calls made by the real services under test.
	h.postJSON(t, h.geminiAdminURL+"/admin/seed", req)
}

func (h *harness) geminiState(t *testing.T) admincontract.GeminiStateResponse {
	t.Helper()
	var state admincontract.GeminiStateResponse
	h.getJSON(t, h.geminiAdminURL+"/admin/state", &state)
	return state
}

func (h *harness) seedTodoist(t *testing.T, req admincontract.SeedTodoistStateRequest) {
	t.Helper()
	h.postJSON(t, h.todoistAdminURL+"/admin/seed", req)
}

func (h *harness) queueTodoist(t *testing.T, req admincontract.QueueTodoistResponsesRequest) {
	t.Helper()
	h.postJSON(t, h.todoistAdminURL+"/admin/queue", req)
}

func (h *harness) todoistState(t *testing.T) admincontract.TodoistStateResponse {
	t.Helper()
	var state admincontract.TodoistStateResponse
	h.getJSON(t, h.todoistAdminURL+"/admin/state", &state)
	return state
}

func (h *harness) postAPI(t *testing.T, path string, body []byte) (int, []byte) {
	t.Helper()
	return h.doAPI(t, http.MethodPost, path, body)
}

func (h *harness) getAPI(t *testing.T, path string) (int, []byte) {
	t.Helper()
	return h.doAPI(t, http.MethodGet, path, nil)
}

func (h *harness) doAPI(t *testing.T, method string, path string, body []byte) (int, []byte) {
	t.Helper()

	var bodyReader *bytes.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	} else {
		bodyReader = bytes.NewReader(nil)
	}

	req, err := http.NewRequest(method, h.baseURL+path, bodyReader)
	require.NoError(t, err)
	req.SetBasicAuth(h.username, h.password)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := h.httpClient.Do(req)
	require.NoError(t, err)
	defer func() {
		_ = resp.Body.Close()
	}()

	respBody, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return resp.StatusCode, respBody
}

// postJSON/getJSON are small helpers for fake-service admin APIs.
// They intentionally fail fast on non-2xx responses so sut_test.go can stay focused on behavior.
func (h *harness) postJSON(t *testing.T, url string, body any) {
	t.Helper()

	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		require.NoError(t, err)
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	require.NoError(t, err)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := h.httpClient.Do(req)
	require.NoError(t, err)
	defer func() {
		_ = resp.Body.Close()
	}()

	respBody, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Less(t, resp.StatusCode, http.StatusBadRequest, string(respBody))
}

func (h *harness) getJSON(t *testing.T, url string, out any) {
	t.Helper()

	req, err := http.NewRequest(http.MethodGet, url, nil)
	require.NoError(t, err)

	resp, err := h.httpClient.Do(req)
	require.NoError(t, err)
	defer func() {
		_ = resp.Body.Close()
	}()

	respBody, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Less(t, resp.StatusCode, http.StatusBadRequest, string(respBody))
	require.NoError(t, json.Unmarshal(respBody, out))
}

func envOrDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func sanitizeName(value string) string {
	re := regexp.MustCompile(`[^a-zA-Z0-9]+`)
	sanitized := strings.ToLower(re.ReplaceAllString(value, "-"))
	sanitized = strings.Trim(sanitized, "-")
	if sanitized == "" {
		return "sut"
	}
	return sanitized
}

func hashForSummary(text string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(utils.DefaultPromptToSummaryEmail+text)))
}

// cloudmailinPayload mirrors the webhook shape expected by the real HTTP handler.
func cloudmailinPayload(subject string, plain string) []byte {
	payload := map[string]any{
		"headers": map[string]string{
			"from":    "sender@example.com",
			"to":      "todo@example.com",
			"date":    "2026-03-14T12:00:00Z",
			"subject": subject,
		},
		"plain": plain,
		"html":  "",
		"envelope": map[string]string{
			"helo_domain": "gmail.com",
		},
	}
	body, _ := json.Marshal(payload)
	return body
}

func computeWebhookSignature(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func mustUnmarshal[T any](t *testing.T, body []byte) T {
	t.Helper()
	var out T
	require.NoError(t, json.Unmarshal(body, &out), string(body))
	return out
}

func repeatedGenerateFailures(
	n int,
	statusCode int,
	rawBody string,
) []admincontract.GeminiQueuedGenerateContentResponse {
	out := make([]admincontract.GeminiQueuedGenerateContentResponse, 0, n)
	for range n {
		out = append(out, admincontract.GeminiQueuedGenerateContentResponse{
			StatusCode: statusCode,
			RawBody:    rawBody,
		})
	}
	return out
}

func repeatedTodoistResponses(
	n int,
	method string,
	path string,
	statusCode int,
	body string,
) []admincontract.TodoistQueuedResponse {
	out := make([]admincontract.TodoistQueuedResponse, 0, n)
	for range n {
		out = append(out, admincontract.TodoistQueuedResponse{
			Method:     method,
			Path:       path,
			StatusCode: statusCode,
			Body:       body,
		})
	}
	return out
}

func successGenerateContent(text string, tokenCount int32) *geminicontract.GenerateContentResponse {
	return &geminicontract.GenerateContentResponse{
		Candidates: []geminicontract.Candidate{
			{
				Content: geminicontract.Content{
					Parts: []geminicontract.Part{
						{Text: text},
					},
				},
			},
		},
		UsageMetadata: &geminicontract.UsageMetadata{TotalTokenCount: tokenCount},
	}
}
