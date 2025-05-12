package main

import (
	"bytes"
	"html/template"
	"io"
	"net/http"
	"regexp"
	"strings"

	_ "embed"

	"github.com/gin-gonic/gin"
	"github.com/ziyixi/todofy/utils"

	pb "github.com/ziyixi/protos/go/todofy"
)

//go:embed templates/todoDescription.tmpl
var descriptionTmpl string

func HandleUpdateTodo(c *gin.Context) {
	clients := c.MustGet(utils.KeyGRPCClients).(*GRPCClients)
	// get the post data
	jsonRaw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error in reading json body": err.Error()})
		return
	}
	jsonString := string(jsonRaw)
	emailContent := utils.ParseCloudmailin(jsonString)
	if len(emailContent.From) == 0 || len(emailContent.To) == 0 || (len(emailContent.Subject) == 0 && len(emailContent.Content) == 0) {
		c.JSON(http.StatusBadRequest, gin.H{"error in parsing json body": "from/to/subject/content is empty"})
		return
	}
	if strings.HasPrefix(emailContent.Subject, utils.SystemAutomaticallyEmailPrefix) {
		c.JSON(http.StatusOK, gin.H{"accept request": "this is a system automatically email, and will not be processed"})
		return
	}

	// summarize the email content
	summaryReq := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Prompt:      utils.DefaultpromptToSummaryEmail,
		Text:        emailContent.Content,
	}
	llmClient := clients.GetClient("llm").(pb.LLMSummaryServiceClient)
	summaryResp, err := llmClient.Summarize(c, summaryReq)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error in summarizing email": err.Error()})
		return
	}
	// Remove all # started tags in summary, use regex to match [space]#[arbitrary less than 10 characters]
	regex := regexp.MustCompile(`\s#[a-zA-Z0-9]{1,10}\s`)
	summaryResp.Summary = regex.ReplaceAllString(summaryResp.Summary, "<removed tag>")
	emailContentWithSummary := utils.MailInfo{
		From:    emailContent.From,
		To:      emailContent.To,
		Date:    emailContent.Date,
		Subject: emailContent.Subject,
		Content: summaryResp.Summary, // use the summary as the content
	}

	// prepare task description, load template
	tmpl, err := template.New("todoDescription").Parse(descriptionTmpl)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error in parsing template": err.Error()})
	}
	var buf bytes.Buffer
	err = tmpl.Execute(&buf, emailContentWithSummary)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error in executing template": err.Error()})
	}
	todoContent := buf.String()

	// create a todo item
	todoReq := &pb.TodoRequest{
		App:     pb.TodoApp_TODO_APP_DIDA365,
		Method:  pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET,
		Subject: emailContent.Subject,
		Body:    todoContent,
		From:    emailContent.From,
	}
	todoClient := clients.GetClient("todo").(pb.TodoServiceClient)
	_, err = todoClient.PopulateTodo(c, todoReq)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error in creating todo": err.Error()})
		return
	}

	// Write this session to database
	databaseClient := clients.GetClient("database").(pb.DataBaseServiceClient)
	databaseReq := &pb.WriteRequest{
		Type: pb.DatabaseType_DATABASE_TYPE_SQLITE,
		Schema: &pb.DataBaseSchema{
			ModelFamily: summaryReq.ModelFamily,
			Model:       summaryResp.Model,
			Prompt:      summaryReq.Prompt,
			MaxTokens:   summaryReq.MaxTokens,
			Text:        summaryReq.Text,
			Summary:     todoContent,
		},
	}
	_, err = databaseClient.Write(c, databaseReq)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error in writing to database": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "todo created successfully"})
}
