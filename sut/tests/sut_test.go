package tests

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	pb "github.com/ziyixi/protos/go/todofy"
	"github.com/ziyixi/todofy/dependency"
	admincontract "github.com/ziyixi/todofy/sut/contracts/admin"
	geminicontract "github.com/ziyixi/todofy/sut/contracts/gemini"
	"github.com/ziyixi/todofy/todo/todoistapi"
	"github.com/ziyixi/todofy/utils"
)

type summaryHTTPResponse struct {
	Summary         string `json:"summary"`
	TaskCount       int    `json:"task_count"`
	TimeWindowHours int    `json:"time_window_hours"`
}

type recommendationTask struct {
	Rank   int    `json:"rank"`
	Title  string `json:"title"`
	Reason string `json:"reason"`
}

type recommendationHTTPResponse struct {
	Tasks     []recommendationTask `json:"tasks"`
	Model     string               `json:"model"`
	TaskCount int                  `json:"task_count"`
}

type webhookHTTPResponse struct {
	Accepted bool   `json:"accepted"`
	Reason   string `json:"reason"`
	Details  string `json:"details"`
}

const (
	sutExcludedBootstrapProjectA = "proj-excluded-a"
	sutExcludedBootstrapProjectB = "proj-excluded-b"
	temporaryUnavailableBody     = `{"error":"temporary unavailable"}`
	todoistDownBody              = `{"error":"down"}`
	structuredRecommendationJSON = `[
  {"rank":1,"title":"任务一","reason":"先处理"},
  {"rank":2,"title":"任务二","reason":"随后处理"}
]`
)

func newEnabledHarness(t *testing.T) *harness {
	t.Helper()
	if envOrDefault("TODOFY_RUN_SUT", "") != "1" {
		t.Skip("set TODOFY_RUN_SUT=1 to execute SUT integration tests")
	}
	h := newHarness(t)
	t.Cleanup(h.Close)
	return h
}

func reservedTodoistLabels() []todoistapi.Label {
	return []todoistapi.Label{
		{ID: "label-blocked", Name: dependency.LabelBlocked},
		{ID: "label-broken", Name: dependency.LabelBrokenDep},
		{ID: "label-cycle", Name: dependency.LabelCycle},
		{ID: "label-invalid", Name: dependency.LabelInvalidMeta},
	}
}

func mustMarshalJSON(t *testing.T, value any) string {
	t.Helper()
	body, err := json.Marshal(value)
	require.NoError(t, err)
	return string(body)
}

func postTodoistWebhook(t *testing.T, h *harness, reqBody []byte, signature string) webhookHTTPResponse {
	t.Helper()

	req, err := http.NewRequest(http.MethodPost, h.baseURL+"/api/v1/todoist/webhook", strings.NewReader(string(reqBody)))
	require.NoError(t, err)
	req.SetBasicAuth(h.username, h.password)
	req.Header.Set("Content-Type", "application/json")
	if signature != "" {
		req.Header.Set("X-Todoist-Hmac-SHA256", signature)
	}

	resp, err := h.httpClient.Do(req)
	require.NoError(t, err)
	defer func() {
		_ = resp.Body.Close()
	}()
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, resp.StatusCode, string(body))

	return mustUnmarshal[webhookHTTPResponse](t, body)
}

func hasTodoistCall(calls []admincontract.RecordedHTTPRequest, method string, path string) bool {
	for _, call := range calls {
		if call.Method == method && call.Path == path {
			return true
		}
	}
	return false
}

func waitForTodoistCall(t *testing.T, h *harness, timeout time.Duration, method string, path string) bool {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for {
		state := h.todoistState(t)
		if hasTodoistCall(state.Calls, method, path) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestSUTUpdateTodoIntegration(t *testing.T) {
	h := newEnabledHarness(t)

	t.Run("update todo cache miss drives real flow", func(t *testing.T) {
		h.resetScenario(t)
		h.seedGemini(t, admincontract.SeedGeminiStateRequest{
			CountTokensResponses: []admincontract.GeminiQueuedCountTokensResponse{
				{Body: &geminicontract.CountTokensResponse{TotalTokens: 42}},
			},
			GenerateContentResponses: []admincontract.GeminiQueuedGenerateContentResponse{
				{Body: successGenerateContent("Need reply before Friday", 42)},
			},
		})

		status, body := h.postAPI(
			t,
			"/api/v1/update_todo",
			cloudmailinPayload("Quarterly review", "Please reply before Friday."),
		)
		require.Equal(t, http.StatusOK, status, string(body))

		todoistState := h.todoistState(t)
		require.Len(t, todoistState.Tasks, 1)
		assert.Equal(t, "Quarterly review", todoistState.Tasks[0].Content)
		assert.Contains(t, todoistState.Tasks[0].Description, "Need reply before Friday")
		assert.Contains(t, todoistState.Tasks[0].Description, "SUBJECT: Quarterly review")

		geminiState := h.geminiState(t)
		require.Len(t, geminiState.Calls, 2)
		assert.True(t, strings.HasSuffix(geminiState.Calls[0].Path, geminicontract.CountTokensOperation))
		assert.True(t, strings.HasSuffix(geminiState.Calls[1].Path, geminicontract.GenerateContentOperation))

		entries := h.queryEntries(t)
		require.Len(t, entries, 1)
		assert.Contains(t, entries[0].Summary, "Quarterly review")
		assert.Contains(t, entries[0].Summary, "Need reply before Friday")
	})

	t.Run("update todo cache hit skips gemini", func(t *testing.T) {
		h.resetScenario(t)
		emailText := "Please renew the registration."
		h.writeEntry(t, &pb.DataBaseSchema{
			ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
			Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
			Prompt:      utils.DefaultPromptToSummaryEmail,
			Text:        emailText,
			Summary:     "Cached registration summary",
			HashId:      hashForSummary(emailText),
		})

		status, body := h.postAPI(t, "/api/v1/update_todo", cloudmailinPayload("Registration", emailText))
		require.Equal(t, http.StatusOK, status, string(body))

		todoistState := h.todoistState(t)
		require.Len(t, todoistState.Tasks, 1)
		assert.Contains(t, todoistState.Tasks[0].Description, "Cached registration summary")

		assert.Empty(t, h.geminiState(t).Calls)
		assert.Len(t, h.queryEntries(t), 1)
	})

	t.Run("update todo surfaces gemini failures after llm fallback exhaustion", func(t *testing.T) {
		h.resetScenario(t)
		h.seedGemini(t, admincontract.SeedGeminiStateRequest{
			GenerateContentResponses: repeatedGenerateFailures(
				3,
				http.StatusServiceUnavailable,
				temporaryUnavailableBody,
			),
		})

		status, body := h.postAPI(
			t,
			"/api/v1/update_todo",
			cloudmailinPayload("Failure case", "The fake gemini should fail."),
		)
		require.Equal(t, http.StatusInternalServerError, status, string(body))
		assert.Contains(t, string(body), "error in summarizing email")
		assert.Empty(t, h.todoistState(t).Tasks)
		require.Len(t, h.geminiState(t).Calls, 6)
	})

	t.Run("update todo surfaces todoist retry exhaustion", func(t *testing.T) {
		h.resetScenario(t)
		h.seedGemini(t, admincontract.SeedGeminiStateRequest{
			CountTokensResponses: []admincontract.GeminiQueuedCountTokensResponse{
				{Body: &geminicontract.CountTokensResponse{TotalTokens: 20}},
			},
			GenerateContentResponses: []admincontract.GeminiQueuedGenerateContentResponse{
				{Body: successGenerateContent("Todoist should stay down", 20)},
			},
		})
		h.queueTodoist(t, admincontract.QueueTodoistResponsesRequest{
			Responses: repeatedTodoistResponses(
				3,
				http.MethodPost,
				"/api/v1"+todoistapi.TasksPath,
				http.StatusServiceUnavailable,
				todoistDownBody,
			),
		})

		status, body := h.postAPI(
			t,
			"/api/v1/update_todo",
			cloudmailinPayload("Todoist down", "Please fail while creating a task."),
		)
		require.Equal(t, http.StatusInternalServerError, status, string(body))
		assert.Contains(t, string(body), "error in creating todo")
		assert.Len(t, h.todoistState(t).Calls, 3)
	})
}

func TestSUTSummaryIntegration(t *testing.T) {
	h := newEnabledHarness(t)

	t.Run("summary without entries returns fallback text", func(t *testing.T) {
		h.resetScenario(t)

		status, body := h.getAPI(t, "/api/summary")
		require.Equal(t, http.StatusOK, status, string(body))

		resp := mustUnmarshal[summaryHTTPResponse](t, body)
		assert.Equal(t, 0, resp.TaskCount)
		assert.Contains(t, resp.Summary, "no new task")
		assert.Empty(t, h.geminiState(t).Calls)
	})

	t.Run("summary with entries uses gemini", func(t *testing.T) {
		h.resetScenario(t)
		h.writeEntry(t, &pb.DataBaseSchema{Summary: "Task one summary"})
		h.writeEntry(t, &pb.DataBaseSchema{Summary: "Task two summary"})
		h.seedGemini(t, admincontract.SeedGeminiStateRequest{
			CountTokensResponses: []admincontract.GeminiQueuedCountTokensResponse{
				{Body: &geminicontract.CountTokensResponse{TotalTokens: 50}},
			},
			GenerateContentResponses: []admincontract.GeminiQueuedGenerateContentResponse{
				{Body: successGenerateContent("Daily digest", 50)},
			},
		})

		status, body := h.getAPI(t, "/api/summary")
		require.Equal(t, http.StatusOK, status, string(body))

		resp := mustUnmarshal[summaryHTTPResponse](t, body)
		assert.Equal(t, 2, resp.TaskCount)
		assert.Equal(t, "Daily digest", resp.Summary)
		require.Len(t, h.geminiState(t).Calls, 2)
	})

	t.Run("summary reports malformed gemini responses", func(t *testing.T) {
		h.resetScenario(t)
		h.writeEntry(t, &pb.DataBaseSchema{Summary: "Task summary"})
		h.seedGemini(t, admincontract.SeedGeminiStateRequest{
			GenerateContentResponses: repeatedGenerateFailures(3, http.StatusOK, "not-json"),
		})

		status, body := h.getAPI(t, "/api/summary")
		require.Equal(t, http.StatusInternalServerError, status, string(body))
		assert.Contains(t, string(body), "error in summarizing email")
	})
}

func TestSUTRecommendationIntegration(t *testing.T) {
	h := newEnabledHarness(t)

	t.Run("recommendation returns structured tasks", func(t *testing.T) {
		h.resetScenario(t)
		h.writeEntry(t, &pb.DataBaseSchema{Summary: "First task"})
		h.writeEntry(t, &pb.DataBaseSchema{Summary: "Second task"})
		h.seedGemini(t, admincontract.SeedGeminiStateRequest{
			CountTokensResponses: []admincontract.GeminiQueuedCountTokensResponse{
				{Body: &geminicontract.CountTokensResponse{TotalTokens: 64}},
			},
			GenerateContentResponses: []admincontract.GeminiQueuedGenerateContentResponse{
				{Body: successGenerateContent(structuredRecommendationJSON, 64)},
			},
		})

		status, body := h.getAPI(t, "/api/recommendation?top=2")
		require.Equal(t, http.StatusOK, status, string(body))

		resp := mustUnmarshal[recommendationHTTPResponse](t, body)
		require.Len(t, resp.Tasks, 2)
		assert.Equal(t, "任务一", resp.Tasks[0].Title)
		assert.NotEmpty(t, resp.Model)
	})

	t.Run("recommendation falls back to raw text", func(t *testing.T) {
		h.resetScenario(t)
		h.writeEntry(t, &pb.DataBaseSchema{Summary: "Only task"})
		h.seedGemini(t, admincontract.SeedGeminiStateRequest{
			CountTokensResponses: []admincontract.GeminiQueuedCountTokensResponse{
				{Body: &geminicontract.CountTokensResponse{TotalTokens: 16}},
			},
			GenerateContentResponses: []admincontract.GeminiQueuedGenerateContentResponse{
				{Body: successGenerateContent("plain text recommendation", 16)},
			},
		})

		status, body := h.getAPI(t, "/api/recommendation")
		require.Equal(t, http.StatusOK, status, string(body))

		resp := mustUnmarshal[recommendationHTTPResponse](t, body)
		require.Len(t, resp.Tasks, 1)
		assert.Equal(t, "recommendation", resp.Tasks[0].Title)
		assert.Equal(t, "plain text recommendation", resp.Tasks[0].Reason)
	})

	t.Run("recommendation validates top query", func(t *testing.T) {
		h.resetScenario(t)

		status, body := h.getAPI(t, "/api/recommendation?top=99")
		require.Equal(t, http.StatusBadRequest, status, string(body))
		assert.Contains(t, string(body), "invalid top parameter")
		assert.Empty(t, h.geminiState(t).Calls)
	})
}

func TestSUTDependencyIntegration(t *testing.T) {
	h := newEnabledHarness(t)

	t.Run("dependency reconcile updates labels with real graph logic", func(t *testing.T) {
		h.resetScenario(t)
		h.seedTodoist(t, admincontract.SeedTodoistStateRequest{
			Tasks: []todoistapi.Task{
				{ID: "1", Content: "Task A <k:task-a>"},
				{ID: "2", Content: "Task B <k:task-b dep:task-a>"},
				{ID: "3", Content: "Task C <k:task-c dep:missing>"},
			},
		})

		status, body := h.postAPI(t, "/api/v1/dependency/reconcile", []byte(`{}`))
		require.Equal(t, http.StatusOK, status, string(body))

		resp := mustUnmarshal[pb.ReconcileDependencyGraphResponse](t, body)
		assert.Equal(t, int32(3), resp.TaskCount)
		assert.Equal(t, int32(2), resp.UpdatedTaskCount)

		state := h.todoistState(t)
		require.Len(t, state.Tasks, 3)
		require.Len(t, state.Labels, 4)
		assert.Contains(t, state.Tasks[1].Labels, "dag_blocked")
		assert.Contains(t, state.Tasks[2].Labels, "dag_broken_dep")
	})

	t.Run("dependency bootstrap persists generated keys", func(t *testing.T) {
		h.resetScenario(t)
		h.seedTodoist(t, admincontract.SeedTodoistStateRequest{
			Tasks: []todoistapi.Task{
				{ID: "1", Content: "Loose task", ProjectID: "proj-1"},
				{ID: "2", Content: "Existing task <k:existing>", ProjectID: "proj-1"},
			},
		})

		status, body := h.postAPI(t, "/api/v1/dependency/bootstrap_keys?dry_run=false", []byte(`{}`))
		require.Equal(t, http.StatusOK, status, string(body))

		resp := mustUnmarshal[pb.BootstrapMissingTaskKeysResponse](t, body)
		assert.Equal(t, int32(1), resp.GeneratedCount)
		require.Len(t, resp.GeneratedTaskKeys, 1)

		state := h.todoistState(t)
		assert.Contains(t, state.Tasks[0].Content, "<k:")
		assert.Contains(t, state.Tasks[1].Content, "<k:existing>")
	})

	t.Run("dependency bootstrap skips excluded projects", func(t *testing.T) {
		h.resetScenario(t)
		h.seedTodoist(t, admincontract.SeedTodoistStateRequest{
			Tasks: []todoistapi.Task{
				{ID: "1", Content: "Excluded inbox task", ProjectID: sutExcludedBootstrapProjectA},
				{ID: "2", Content: "Excluded project task", ProjectID: sutExcludedBootstrapProjectB},
				{ID: "3", Content: "Included task", ProjectID: "proj-keep"},
				{ID: "4", Content: "Existing task <k:existing>", ProjectID: sutExcludedBootstrapProjectA},
			},
		})

		status, body := h.postAPI(t, "/api/v1/dependency/bootstrap_keys?dry_run=false", []byte(`{}`))
		require.Equal(t, http.StatusOK, status, string(body))

		resp := mustUnmarshal[pb.BootstrapMissingTaskKeysResponse](t, body)
		assert.Equal(t, int32(1), resp.GeneratedCount)
		require.Len(t, resp.GeneratedTaskKeys, 1)
		assert.Equal(t, "3", resp.GeneratedTaskKeys[0].TodoistTaskId)

		state := h.todoistState(t)
		require.Len(t, state.Tasks, 4)
		contentsByID := make(map[string]string, len(state.Tasks))
		for _, task := range state.Tasks {
			contentsByID[task.ID] = task.Content
		}
		assert.NotContains(t, contentsByID["1"], "<k:")
		assert.NotContains(t, contentsByID["2"], "<k:")
		assert.Contains(t, contentsByID["3"], "<k:")
		assert.Contains(t, contentsByID["4"], "<k:existing>")
	})

	t.Run("dependency status and issues expose analyzed graph", func(t *testing.T) {
		h.resetScenario(t)
		h.seedTodoist(t, admincontract.SeedTodoistStateRequest{
			Tasks: []todoistapi.Task{
				{ID: "1", Content: "Task A <k:task-a>"},
				{ID: "2", Content: "Task B <k:task-b dep:task-a>"},
				{ID: "3", Content: "Task C <k:task-c dep:missing>"},
			},
		})

		status, body := h.getAPI(t, "/api/v1/dependency/status?task_key=task-b")
		require.Equal(t, http.StatusOK, status, string(body))
		statusResp := mustUnmarshal[pb.GetTaskDependencyStatusResponse](t, body)
		require.NotNil(t, statusResp.Status)
		assert.Equal(t, pb.TaskReadinessState_TASK_READINESS_STATE_BLOCKED, statusResp.Status.Readiness)
		assert.Equal(t, []string{"task-a"}, statusResp.Status.UnmetDependencyKeys)

		status, body = h.getAPI(t, "/api/v1/dependency/issues?type=broken_reference")
		require.Equal(t, http.StatusOK, status, string(body))
		issuesResp := mustUnmarshal[pb.ListDependencyIssuesResponse](t, body)
		require.Len(t, issuesResp.Issues, 1)
		assert.Equal(t, "task-c", issuesResp.Issues[0].TaskKey)
	})

	t.Run("dependency reconcile tolerates partial label ensure failures", func(t *testing.T) {
		h.resetScenario(t)
		h.seedTodoist(t, admincontract.SeedTodoistStateRequest{
			Tasks: []todoistapi.Task{
				{ID: "1", Content: "Task A <k:task-a>"},
				{ID: "2", Content: "Task B <k:task-b dep:task-a>"},
			},
			QueuedResponses: []admincontract.TodoistQueuedResponse{
				{
					Method:     http.MethodPost,
					Path:       "/api/v1" + todoistapi.LabelsPath,
					StatusCode: http.StatusBadGateway,
					Body:       `{"error":"label create failed"}`,
				},
			},
		})

		status, body := h.postAPI(t, "/api/v1/dependency/reconcile", []byte(`{}`))
		require.Equal(t, http.StatusOK, status, string(body))

		state := h.todoistState(t)
		assert.Empty(t, state.QueuedResponses)
		assert.GreaterOrEqual(t, len(state.Labels), 3)

		labelCreateCalls := 0
		var blockedTask *todoistapi.Task
		for i := range state.Tasks {
			if state.Tasks[i].ID == "2" {
				blockedTask = &state.Tasks[i]
			}
		}
		for _, call := range state.Calls {
			if call.Method == http.MethodPost && call.Path == "/api/v1"+todoistapi.LabelsPath {
				labelCreateCalls++
			}
		}

		require.NotNil(t, blockedTask)
		assert.Contains(t, blockedTask.Labels, "dag_blocked")
		assert.GreaterOrEqual(t, labelCreateCalls, 1)
	})

	t.Run("dependency reconcile returns partial success and later recovers failed task updates", func(t *testing.T) {
		h.resetScenario(t)
		h.seedTodoist(t, admincontract.SeedTodoistStateRequest{
			Tasks: []todoistapi.Task{
				{ID: "1", Content: "Task A <k:task-a dep:task-b>"},
				{ID: "2", Content: "Task B <k:task-b>"},
				{ID: "3", Content: "Task C <k:task-c dep:missing>"},
			},
			Labels: reservedTodoistLabels(),
			QueuedResponses: repeatedTodoistResponses(
				3,
				http.MethodPost,
				"/api/v1/tasks/1",
				http.StatusServiceUnavailable,
				todoistDownBody,
			),
		})

		status, body := h.postAPI(t, "/api/v1/dependency/reconcile", []byte(`{}`))
		require.Equal(t, http.StatusOK, status, string(body))

		resp := mustUnmarshal[pb.ReconcileDependencyGraphResponse](t, body)
		assert.True(t, resp.GetPartialSuccess())
		assert.Equal(t, int32(1), resp.GetUpdatedTaskCount())
		assert.Equal(t, int32(1), resp.GetFailedUpdateCount())
		require.Len(t, resp.GetWriteFailures(), 1)
		assert.Equal(t, "1", resp.GetWriteFailures()[0].GetTodoistTaskId())
		assert.Equal(t, "task-a", resp.GetWriteFailures()[0].GetTaskKey())
		assert.Equal(t, "update_labels", resp.GetWriteFailures()[0].GetOperation())

		state := h.todoistState(t)
		labelsByID := make(map[string][]string, len(state.Tasks))
		for _, task := range state.Tasks {
			labelsByID[task.ID] = append([]string(nil), task.Labels...)
		}
		assert.NotContains(t, labelsByID["1"], dependency.LabelBlocked)
		assert.Contains(t, labelsByID["3"], dependency.LabelBrokenDep)

		status, body = h.postAPI(t, "/api/v1/dependency/reconcile", []byte(`{}`))
		require.Equal(t, http.StatusOK, status, string(body))

		resp = mustUnmarshal[pb.ReconcileDependencyGraphResponse](t, body)
		assert.False(t, resp.GetPartialSuccess())
		assert.Equal(t, int32(1), resp.GetUpdatedTaskCount())
		assert.Zero(t, resp.GetFailedUpdateCount())

		state = h.todoistState(t)
		labelsByID = make(map[string][]string, len(state.Tasks))
		for _, task := range state.Tasks {
			labelsByID[task.ID] = append([]string(nil), task.Labels...)
		}
		assert.Contains(t, labelsByID["1"], dependency.LabelBlocked)
	})

	t.Run("dependency bootstrap returns partial success and later recovers failed content updates", func(t *testing.T) {
		h.resetScenario(t)
		h.seedTodoist(t, admincontract.SeedTodoistStateRequest{
			Tasks: []todoistapi.Task{
				{ID: "1", Content: "First task", ProjectID: "proj-1"},
				{ID: "2", Content: "Second task", ProjectID: "proj-1"},
			},
			QueuedResponses: repeatedTodoistResponses(
				3,
				http.MethodPost,
				"/api/v1/tasks/1",
				http.StatusServiceUnavailable,
				todoistDownBody,
			),
		})

		status, body := h.postAPI(t, "/api/v1/dependency/bootstrap_keys?dry_run=false", []byte(`{}`))
		require.Equal(t, http.StatusOK, status, string(body))

		resp := mustUnmarshal[pb.BootstrapMissingTaskKeysResponse](t, body)
		assert.True(t, resp.GetPartialSuccess())
		assert.Equal(t, int32(1), resp.GetGeneratedCount())
		assert.Equal(t, int32(1), resp.GetFailedUpdateCount())
		require.Len(t, resp.GetWriteFailures(), 1)
		assert.Equal(t, "1", resp.GetWriteFailures()[0].GetTodoistTaskId())
		assert.Equal(t, "update_content", resp.GetWriteFailures()[0].GetOperation())

		state := h.todoistState(t)
		contentsByID := make(map[string]string, len(state.Tasks))
		for _, task := range state.Tasks {
			contentsByID[task.ID] = task.Content
		}
		assert.NotContains(t, contentsByID["1"], "<k:")
		assert.Contains(t, contentsByID["2"], "<k:")

		status, body = h.postAPI(t, "/api/v1/dependency/bootstrap_keys?dry_run=false", []byte(`{}`))
		require.Equal(t, http.StatusOK, status, string(body))

		resp = mustUnmarshal[pb.BootstrapMissingTaskKeysResponse](t, body)
		assert.False(t, resp.GetPartialSuccess())
		assert.Equal(t, int32(1), resp.GetGeneratedCount())
		assert.Zero(t, resp.GetFailedUpdateCount())

		state = h.todoistState(t)
		contentsByID = make(map[string]string, len(state.Tasks))
		for _, task := range state.Tasks {
			contentsByID[task.ID] = task.Content
		}
		assert.Contains(t, contentsByID["1"], "<k:")
	})

	t.Run("dependency reconcile timeout returns gateway timeout and later recovers", func(t *testing.T) {
		h.resetScenario(t)
		labels := reservedTodoistLabels()
		h.seedTodoist(t, admincontract.SeedTodoistStateRequest{
			Tasks: []todoistapi.Task{
				{ID: "1", Content: "Task A <k:task-a dep:task-b>"},
				{ID: "2", Content: "Task B <k:task-b>"},
			},
			Labels: labels,
			QueuedResponses: []admincontract.TodoistQueuedResponse{
				{
					Method:     http.MethodGet,
					Path:       "/api/v1" + todoistapi.LabelsPath,
					StatusCode: http.StatusOK,
					DelayMs:    1500,
					Body:       mustMarshalJSON(t, labels),
				},
			},
		})

		status, body := h.postAPI(t, "/api/v1/dependency/reconcile", []byte(`{}`))
		require.Equal(t, http.StatusGatewayTimeout, status, string(body))
		assert.Contains(t, string(body), "timed out")

		status, body = h.postAPI(t, "/api/v1/dependency/reconcile", []byte(`{}`))
		require.Equal(t, http.StatusOK, status, string(body))

		resp := mustUnmarshal[pb.ReconcileDependencyGraphResponse](t, body)
		assert.False(t, resp.GetPartialSuccess())

		state := h.todoistState(t)
		require.Len(t, state.Tasks, 2)
		assert.Contains(t, state.Tasks[0].Labels, dependency.LabelBlocked)
	})

	t.Run("dependency bootstrap timeout returns gateway timeout and later recovers", func(t *testing.T) {
		h.resetScenario(t)
		delayedTasks := []todoistapi.Task{
			{ID: "1", Content: "Task A", ProjectID: "proj-1"},
		}
		h.seedTodoist(t, admincontract.SeedTodoistStateRequest{
			Tasks: delayedTasks,
			QueuedResponses: []admincontract.TodoistQueuedResponse{
				{
					Method:     http.MethodGet,
					Path:       "/api/v1" + todoistapi.TasksPath,
					StatusCode: http.StatusOK,
					DelayMs:    1500,
					Body:       mustMarshalJSON(t, delayedTasks),
				},
			},
		})

		status, body := h.postAPI(t, "/api/v1/dependency/bootstrap_keys?dry_run=false", []byte(`{}`))
		require.Equal(t, http.StatusGatewayTimeout, status, string(body))
		assert.Contains(t, string(body), "timed out")

		status, body = h.postAPI(t, "/api/v1/dependency/bootstrap_keys?dry_run=false", []byte(`{}`))
		require.Equal(t, http.StatusOK, status, string(body))

		resp := mustUnmarshal[pb.BootstrapMissingTaskKeysResponse](t, body)
		assert.False(t, resp.GetPartialSuccess())
		assert.Equal(t, int32(1), resp.GetGeneratedCount())

		state := h.todoistState(t)
		require.Len(t, state.Tasks, 1)
		assert.Contains(t, state.Tasks[0].Content, "<k:")
	})
}

func TestSUTTodoistWebhookIntegration(t *testing.T) {
	h := newEnabledHarness(t)

	t.Run("todoist webhook rejects invalid signatures", func(t *testing.T) {
		h.resetScenario(t)

		reqBody := []byte(`{"event_data":{"id":"task-1","content":"Task A <k:task-a>"}}`)
		webhookResp := postTodoistWebhook(t, h, reqBody, "invalid")
		assert.False(t, webhookResp.Accepted)
		assert.Equal(t, "invalid_signature", webhookResp.Reason)
	})

	t.Run("todoist webhook accepts valid signatures", func(t *testing.T) {
		h.resetScenario(t)

		reqBody := []byte(`{"event_data":{"id":"task-1","content":"Task A <k:task-a>"}}`)
		webhookResp := postTodoistWebhook(t, h, reqBody, computeWebhookSignature(h.webhookSecret, reqBody))
		assert.True(t, webhookResp.Accepted)
		assert.Equal(t, "ok", webhookResp.Reason)
	})

	t.Run("excluded project webhook does not trigger reconcile list call", func(t *testing.T) {
		h.resetScenario(t)
		h.seedTodoist(t, admincontract.SeedTodoistStateRequest{
			Tasks: []todoistapi.Task{
				{ID: "task-1", Content: "Task A <k:task-a>", ProjectID: sutExcludedBootstrapProjectA},
			},
		})

		reqBody := []byte(`{"event_data":{"id":"task-1","content":"Task A <k:task-a>"}}`)
		webhookResp := postTodoistWebhook(t, h, reqBody, computeWebhookSignature(h.webhookSecret, reqBody))
		assert.True(t, webhookResp.Accepted)
		assert.Equal(t, "ok", webhookResp.Reason)

		require.True(
			t,
			waitForTodoistCall(t, h, time.Second, http.MethodGet, "/api/v1"+todoistapi.TasksPath+"/task-1"),
			"expected webhook exclusion check to resolve task project via GET /tasks/{id}",
		)
		assert.False(
			t,
			waitForTodoistCall(t, h, time.Second, http.MethodGet, "/api/v1"+todoistapi.TasksPath),
			"excluded-project webhook should not enqueue reconcile list call",
		)
	})

	t.Run("moved task from excluded to included project triggers reconcile", func(t *testing.T) {
		h.resetScenario(t)
		reqBody := []byte(`{"event_data":{"id":"task-1","content":"Task A <k:task-a>"}}`)

		h.seedTodoist(t, admincontract.SeedTodoistStateRequest{
			Tasks: []todoistapi.Task{
				{ID: "task-1", Content: "Task A <k:task-a>", ProjectID: sutExcludedBootstrapProjectA},
			},
		})

		webhookResp := postTodoistWebhook(t, h, reqBody, computeWebhookSignature(h.webhookSecret, reqBody))
		assert.True(t, webhookResp.Accepted)
		assert.Equal(t, "ok", webhookResp.Reason)
		assert.False(
			t,
			waitForTodoistCall(t, h, time.Second, http.MethodGet, "/api/v1"+todoistapi.TasksPath),
			"excluded-project webhook should not trigger reconcile before move",
		)

		h.seedTodoist(t, admincontract.SeedTodoistStateRequest{
			Tasks: []todoistapi.Task{
				{ID: "task-1", Content: "Task A <k:task-a>", ProjectID: "proj-keep"},
			},
		})

		webhookResp = postTodoistWebhook(t, h, reqBody, computeWebhookSignature(h.webhookSecret, reqBody))
		assert.True(t, webhookResp.Accepted)
		assert.Equal(t, "ok", webhookResp.Reason)
		assert.True(
			t,
			waitForTodoistCall(t, h, 2*time.Second, http.MethodGet, "/api/v1"+todoistapi.TasksPath),
			"included-project webhook should trigger reconcile list call after move",
		)
	})
}
