package main

import (
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
	pb "github.com/ziyixi/protos/go/todofy"
	"github.com/ziyixi/todofy/dependency"
	"github.com/ziyixi/todofy/utils"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// HandleDependencyReconcile triggers dependency graph reconcile or analyze-only mode.
func HandleDependencyReconcile(c *gin.Context) {
	dependencyClient, ok := getDependencyClient(c)
	if !ok {
		return
	}

	dryRun, err := parseBoolQuery(c, "dry_run", false)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if dryRun {
		resp, rpcErr := dependencyClient.AnalyzeGraph(c, &pb.AnalyzeDependencyGraphRequest{})
		if rpcErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": rpcErr.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"mode":   "dry_run",
			"report": resp,
		})
		return
	}

	resp, rpcErr := dependencyClient.ReconcileGraph(c, &pb.ReconcileDependencyGraphRequest{})
	if rpcErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": rpcErr.Error()})
		return
	}
	c.JSON(http.StatusOK, resp)
}

// HandleDependencyBootstrapMissingKeys generates missing task keys for tasks without metadata keys.
func HandleDependencyBootstrapMissingKeys(c *gin.Context) {
	dependencyClient, ok := getDependencyClient(c)
	if !ok {
		return
	}

	dryRun, err := parseBoolQuery(c, "dry_run", true)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	resp, rpcErr := dependencyClient.BootstrapMissingTaskKeys(c, &pb.BootstrapMissingTaskKeysRequest{
		DryRun: dryRun,
	})
	if rpcErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": rpcErr.Error()})
		return
	}
	c.JSON(http.StatusOK, resp)
}

// HandleDependencyStatus returns computed dependency status for a task key or Todoist task id.
func HandleDependencyStatus(c *gin.Context) {
	dependencyClient, ok := getDependencyClient(c)
	if !ok {
		return
	}

	taskKey := strings.TrimSpace(c.Query("task_key"))
	taskID := strings.TrimSpace(c.Query("todoist_task_id"))
	if taskKey == "" && taskID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "task_key or todoist_task_id is required"})
		return
	}

	resp, rpcErr := dependencyClient.GetTaskStatus(c, &pb.GetTaskDependencyStatusRequest{
		TaskKey:       taskKey,
		TodoistTaskId: taskID,
	})
	if rpcErr != nil {
		if status.Code(rpcErr) == codes.NotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": rpcErr.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": rpcErr.Error()})
		return
	}
	c.JSON(http.StatusOK, resp)
}

// HandleDependencyIssues lists dependency issues with optional type and task key filters.
func HandleDependencyIssues(c *gin.Context) {
	dependencyClient, ok := getDependencyClient(c)
	if !ok {
		return
	}

	issueType, err := parseIssueType(c.Query("type"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	resp, rpcErr := dependencyClient.ListDependencyIssues(c, &pb.ListDependencyIssuesRequest{
		Type:    issueType,
		TaskKey: strings.TrimSpace(c.Query("task_key")),
	})
	if rpcErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": rpcErr.Error()})
		return
	}
	c.JSON(http.StatusOK, resp)
}

// HandleTodoistWebhook validates a Todoist webhook and marks dependency state as dirty.
func HandleTodoistWebhook(c *gin.Context) {
	dependencyClient, ok := getDependencyClient(c)
	if !ok {
		return
	}
	todoistClient, ok := getTodoistClient(c)
	if !ok {
		return
	}

	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to read request body"})
		return
	}

	signature := c.GetHeader("X-Todoist-Hmac-SHA256")
	verifyReq := &pb.VerifyTodoistWebhookRequest{
		RawBody:   body,
		Headers:   extractWebhookHeaders(c),
		Signature: strings.TrimSpace(signature),
	}
	verifyResp, verifyErr := todoistClient.VerifyWebhook(c, verifyReq)
	if verifyErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"accepted": false,
			"reason":   "verify_failed",
			"details":  verifyErr.Error(),
		})
		return
	}
	if !verifyResp.GetValid() {
		c.JSON(http.StatusUnauthorized, gin.H{
			"accepted": false,
			"reason":   verifyResp.GetReason(),
			"details":  verifyResp.GetDetails(),
		})
		return
	}

	markResp, markErr := dependencyClient.MarkGraphDirty(c, &pb.MarkDependencyGraphDirtyRequest{
		Source:         "todoist_webhook",
		Reason:         "webhook_event",
		WebhookEventId: firstNonEmptyHeader(c, "X-Todoist-Delivery-ID", "X-Todoist-Event-Id"),
		TodoistTaskIds: extractWebhookTaskIDs(body),
		TaskKeys:       extractWebhookTaskKeys(body),
	})
	if markErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"accepted": false,
			"reason":   "mark_graph_dirty_failed",
			"details":  markErr.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"accepted": markResp.GetAccepted(),
		"reason":   verifyResp.GetReason(),
	})
}

func getDependencyClient(c *gin.Context) (pb.DependencyServiceClient, bool) {
	clients := c.MustGet(utils.KeyGRPCClients).(ClientProvider)
	client := clients.GetClient("dependency")
	if client == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "dependency client not configured"})
		return nil, false
	}
	dependencyClient, ok := client.(pb.DependencyServiceClient)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "dependency client has unexpected type"})
		return nil, false
	}
	return dependencyClient, true
}

func getTodoistClient(c *gin.Context) (pb.TodoistServiceClient, bool) {
	clients := c.MustGet(utils.KeyGRPCClients).(ClientProvider)
	client := clients.GetClient("todoist")
	if client == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "todoist client not configured"})
		return nil, false
	}
	todoistClient, ok := client.(pb.TodoistServiceClient)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "todoist client has unexpected type"})
		return nil, false
	}
	return todoistClient, true
}

func parseBoolQuery(c *gin.Context, key string, defaultValue bool) (bool, error) {
	raw := strings.TrimSpace(c.Query(key))
	if raw == "" {
		return defaultValue, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return false, strconv.ErrSyntax
	}
	return value, nil
}

func parseIssueType(raw string) (pb.DependencyIssueType, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_UNSPECIFIED, nil
	}

	if value, err := strconv.Atoi(raw); err == nil {
		issueType := pb.DependencyIssueType(value)
		if _, exists := pb.DependencyIssueType_name[int32(issueType)]; exists {
			return issueType, nil
		}
		return pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_UNSPECIFIED, strconv.ErrRange
	}

	normalized := strings.ToUpper(raw)
	if !strings.HasPrefix(normalized, "DEPENDENCY_ISSUE_TYPE_") {
		normalized = "DEPENDENCY_ISSUE_TYPE_" + normalized
	}
	if value, exists := pb.DependencyIssueType_value[normalized]; exists {
		return pb.DependencyIssueType(value), nil
	}
	return pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_UNSPECIFIED, strconv.ErrSyntax
}

func extractWebhookHeaders(c *gin.Context) []*pb.TodoistWebhookHeader {
	headers := make([]*pb.TodoistWebhookHeader, 0, len(c.Request.Header))
	for key, values := range c.Request.Header {
		for _, value := range values {
			headers = append(headers, &pb.TodoistWebhookHeader{
				Key:   key,
				Value: value,
			})
		}
	}
	return headers
}

func firstNonEmptyHeader(c *gin.Context, keys ...string) string {
	for _, key := range keys {
		value := strings.TrimSpace(c.GetHeader(key))
		if value != "" {
			return value
		}
	}
	return ""
}

func extractWebhookTaskIDs(raw []byte) []string {
	candidates := []string{
		gjson.GetBytes(raw, "event_data.id").String(),
		gjson.GetBytes(raw, "event_data.task_id").String(),
		gjson.GetBytes(raw, "event_data.item_id").String(),
	}

	items := gjson.GetBytes(raw, "event_data.items")
	if items.IsArray() {
		for _, item := range items.Array() {
			id := strings.TrimSpace(item.Get("id").String())
			if id != "" {
				candidates = append(candidates, id)
			}
		}
	}

	return dedupeNonEmpty(candidates)
}

func extractWebhookTaskKeys(raw []byte) []string {
	content := strings.TrimSpace(gjson.GetBytes(raw, "event_data.content").String())
	if content == "" {
		return nil
	}
	parsed := dependency.ParseTaskMetadata(content)
	if !parsed.Valid || parsed.TaskKey == "" {
		return nil
	}
	return []string{parsed.TaskKey}
}

func dedupeNonEmpty(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}
