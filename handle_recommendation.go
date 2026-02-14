package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/ziyixi/todofy/utils"

	pb "github.com/ziyixi/protos/go/todofy"
)

const (
	TimeDurationToRecommendation = 24 * time.Hour
	DefaultTopN                  = 3
	MaxTopN                      = 10
)

// TaskRecommendation represents a single recommended task entry.
type TaskRecommendation struct {
	Rank   int    `json:"rank"`
	Title  string `json:"title"`
	Reason string `json:"reason"`
}

// RecommendationResponse is the top-level JSON response.
type RecommendationResponse struct {
	Tasks     []TaskRecommendation `json:"tasks"`
	Model     string               `json:"model"`
	TaskCount int                  `json:"task_count"`
}

// HandleRecommendation queries recent tasks from the last 24 hours,
// asks the LLM to pick the top-N most important ones, and returns
// the result as a structured JSON array for consumption by other apps.
// Optional query parameter: ?top=N (default 3, max 10).
func HandleRecommendation(c *gin.Context) {
	clients := c.MustGet(utils.KeyGRPCClients).(ClientProvider)

	// Parse optional "top" query parameter
	topN := DefaultTopN
	if topStr := c.Query("top"); topStr != "" {
		if n, err := strconv.Atoi(topStr); err == nil && n >= 1 && n <= MaxTopN {
			topN = n
		} else {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf(
					"invalid top parameter: must be 1-%d", MaxTopN),
			})
			return
		}
	}

	// Query recent tasks from the database
	databaseClient := clients.GetClient("database").(pb.DataBaseServiceClient)
	queryReq := &pb.QueryRecentRequest{
		Type:             pb.DatabaseType_DATABASE_TYPE_SQLITE,
		TimeAgoInSeconds: int64(TimeDurationToRecommendation.Seconds()),
	}
	queryResp, err := databaseClient.QueryRecent(c, queryReq)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if len(queryResp.Entries) == 0 {
		c.JSON(http.StatusOK, RecommendationResponse{
			Tasks:     []TaskRecommendation{},
			TaskCount: 0,
		})
		return
	}

	// Build content from task summaries
	splitter := "=========================\n"
	content := splitter
	for _, entry := range queryResp.Entries {
		content += entry.Summary + "\n" + splitter
	}

	// Generate recommendation via LLM
	prompt := fmt.Sprintf(
		utils.DefaultPromptToRecommendTopTasks,
		topN, topN, topN, topN,
	)
	recReq := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Prompt:      prompt,
		Text:        content,
	}
	llmClient := clients.GetClient("llm").(pb.LLMSummaryServiceClient)
	recResp, err := llmClient.Summarize(c, recReq)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Parse the JSON array from LLM response
	var tasks []TaskRecommendation
	raw := strings.TrimSpace(recResp.Summary)
	// Strip markdown code fences if the LLM wraps the output
	raw = strings.TrimPrefix(raw, "```json")
	raw = strings.TrimPrefix(raw, "```")
	raw = strings.TrimSuffix(raw, "```")
	raw = strings.TrimSpace(raw)

	if err := json.Unmarshal([]byte(raw), &tasks); err != nil {
		// Fallback: return raw text as a single entry so callers still get data
		tasks = []TaskRecommendation{
			{Rank: 1, Title: "recommendation", Reason: recResp.Summary},
		}
	}

	c.JSON(http.StatusOK, RecommendationResponse{
		Tasks:     tasks,
		Model:     recResp.Model.String(),
		TaskCount: len(queryResp.Entries),
	})
}
