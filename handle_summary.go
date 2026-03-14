package main

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/ziyixi/todofy/utils"

	pb "github.com/ziyixi/protos/go/todofy"
)

const (
	TimeDurationToSummary = 24 * time.Hour // 24 hours
)

// HandleSummary returns a 24-hour summary generated from recent persisted task entries.
func HandleSummary(c *gin.Context) {
	clients := c.MustGet(utils.KeyGRPCClients).(ClientProvider)

	// Query all the data from the database
	databaseClient := clients.GetClient("database").(pb.DataBaseServiceClient)
	queryReq := &pb.QueryRecentRequest{
		Type:             pb.DatabaseType_DATABASE_TYPE_SQLITE,
		TimeAgoInSeconds: int64(TimeDurationToSummary.Seconds()),
	}
	queryResp, err := databaseClient.QueryRecent(c, queryReq)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error in querying database": err.Error()})
		return
	}

	// Build content for the summary
	splitter := "=========================\n"
	content := splitter
	for _, entry := range queryResp.Entries {
		content += entry.Summary + "\n" + splitter
	}

	// Summarize the content
	summaries := "As there is no new task in the last 24 hours, there will have no summary. " +
		"Please check your service as it's highly not possible that there is no new task in the last 24 hours.\n"
	if len(queryResp.Entries) > 0 {
		summaryReq := &pb.LLMSummaryRequest{
			ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
			Prompt:      utils.DefaultPromptToSummaryEmailRange,
			Text:        content,
		}
		llmClient := clients.GetClient("llm").(pb.LLMSummaryServiceClient)
		summaryResp, err := llmClient.Summarize(c, summaryReq)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error in summarizing email": err.Error()})
			return
		}
		summaries = summaryResp.Summary
	}

	c.JSON(http.StatusOK, gin.H{
		"summary":           summaries,
		"task_count":        len(queryResp.Entries),
		"time_window_hours": int(TimeDurationToSummary / time.Hour),
	})
}
