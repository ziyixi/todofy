package main

import (
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/ziyixi/todofy/utils"

	pb "github.com/ziyixi/protos/go/todofy"
)

const (
	TimeDurationToSummary = 24 * time.Hour // 24 hours
)

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
	summmaries := "As there is no new task in the last 24 hours, there will have no summary. " +
		"Please check your service as it's highly not possible that there is no new task in the last 24 hours.\n"
	if len(queryResp.Entries) > 0 {
		summaryReq := &pb.LLMSummaryRequest{
			ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
			Prompt:      utils.DefaultpromptToSummaryEmailRange,
			Text:        content,
		}
		llmClient := clients.GetClient("llm").(pb.LLMSummaryServiceClient)
		summaryResp, err := llmClient.Summarize(c, summaryReq)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error in summarizing email": err.Error()})
			return
		}
		summmaries = summaryResp.Summary
	}

	// Send an email to the user
	todayDate := time.Now().Format("2006-01-02")
	todoReq := &pb.TodoRequest{
		App:     pb.TodoApp_TODO_APP_DIDA365,
		Method:  pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET,
		Subject: utils.SystemAutomaticallyEmailPrefix + fmt.Sprintf("[%s] Summary of last 24 hours", todayDate),
		Body:    summmaries,
		From:    utils.SystemAutomaticallyEmailSender,
		To:      utils.SystemAutomaticallyEmailReceiver,
		ToName:  utils.SystemAutomaticallyEmailReceiverName,
	}
	todoClient := clients.GetClient("todo").(pb.TodoServiceClient)
	_, err = todoClient.PopulateTodo(c, todoReq)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error in creating todo": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "summary email sent successfully"})
}
