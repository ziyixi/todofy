package main

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	pb "github.com/ziyixi/protos/go/todofy"
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
		writeDependencyRPCError(c, rpcErr)
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
		writeDependencyRPCError(c, rpcErr)
		return
	}
	c.JSON(http.StatusOK, resp)
}

// HandleDependencyClearMetadata removes dependency metadata from active tasks.
func HandleDependencyClearMetadata(c *gin.Context) {
	dependencyClient, ok := getDependencyClient(c)
	if !ok {
		return
	}

	dryRun, err := parseBoolQuery(c, "dry_run", true)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	resp, rpcErr := dependencyClient.ClearDependencyMetadata(c, &pb.ClearDependencyMetadataRequest{
		DryRun: dryRun,
	})
	if rpcErr != nil {
		writeDependencyRPCError(c, rpcErr)
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
		writeDependencyRPCError(c, rpcErr)
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
		writeDependencyRPCError(c, rpcErr)
		return
	}
	c.JSON(http.StatusOK, resp)
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

func writeDependencyRPCError(c *gin.Context, err error) {
	statusCode := http.StatusInternalServerError
	if status.Code(err) == codes.DeadlineExceeded {
		statusCode = http.StatusGatewayTimeout
	}
	c.JSON(statusCode, gin.H{"error": err.Error()})
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
