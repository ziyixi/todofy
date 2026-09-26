package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/ziyixi/todofy/utils"

	pb "github.com/ziyixi/protos/go/todofy"
)

var mailSummaryTag = regexp.MustCompile(`\s#[a-zA-Z0-9]{1,10}\s`)

type mailInboxRow struct {
	sourceID string
	eventID  string
	state    string
	payload  []byte
	summary  string
	model    int32
	todoBody string
	taskID   string
	attempts int
}

func (i *mailInbox) nextDue(ctx context.Context) (*mailInboxRow, error) {
	row := new(mailInboxRow)
	err := i.db.QueryRowContext(ctx, `SELECT source_id,event_id,state,payload,summary,
		summary_model,todo_body,task_id,attempt_count FROM mail_inbox_events
		WHERE source_id=? AND state IN ('pending','summarized','todo_created') AND next_attempt_at<=?
		ORDER BY created_at,event_id LIMIT 1`, i.sourceID, time.Now().Unix()).
		Scan(
			&row.sourceID, &row.eventID, &row.state, &row.payload, &row.summary,
			&row.model, &row.todoBody, &row.taskID, &row.attempts,
		)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return row, err
}

func (i *mailInbox) transition(ctx context.Context, row *mailInboxRow, from, to string) (bool, error) {
	result, err := i.db.ExecContext(
		ctx,
		`UPDATE mail_inbox_events SET state=?,updated_at=? WHERE source_id=? AND event_id=? AND state=?`,
		to,
		time.Now().Unix(),
		row.sourceID,
		row.eventID,
		from,
	)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}

func mailRetryDelay(attempts int) time.Duration {
	if attempts > 8 {
		attempts = 8
	}
	if attempts < 0 {
		attempts = 0
	}
	delay := time.Minute * time.Duration(1<<attempts)
	if delay > 6*time.Hour {
		return 6 * time.Hour
	}
	return delay
}

func (i *mailInbox) postpone(ctx context.Context, row *mailInboxRow, state, safeCode string) error {
	next := time.Now().Add(mailRetryDelay(row.attempts)).Unix()
	if row.attempts >= 12 && state == "pending" {
		state = "failed_summary"
		next = 0
	}
	_, err := i.db.ExecContext(ctx, `UPDATE mail_inbox_events SET state=?,attempt_count=attempt_count+1,
		next_attempt_at=?,last_error_code=?,updated_at=? WHERE source_id=? AND event_id=?`,
		state, next, safeCode, time.Now().Unix(), row.sourceID, row.eventID)
	return err
}

func mailEventLabels(event mailReceivedEvent) (from, to, date string) {
	if len(event.Message.From) != 0 {
		from = event.Message.From[0].Address
	}
	if len(event.Message.To) != 0 {
		to = event.Message.To[0].Address
	}
	when := event.ReceivedAt
	if event.Message.SentAt != nil {
		when = *event.Message.SentAt
	}
	return from, to, when.UTC().Format(time.RFC3339)
}

func mailSummaryInput(event mailReceivedEvent) string {
	if strings.TrimSpace(event.Message.Text) != "" {
		return event.Message.Text
	}
	return event.Message.Subject
}

func renderMailTodoBody(event mailReceivedEvent, summary string) (string, error) {
	from, to, date := mailEventLabels(event)
	tmpl, err := template.New("todoDescription").Parse(descriptionTmpl)
	if err != nil {
		return "", err
	}
	var output bytes.Buffer
	if err = tmpl.Execute(&output, utils.MailInfo{
		From: from, To: to, Date: date, Subject: event.Message.Subject, Content: summary,
	}); err != nil {
		return "", err
	}
	// The event ID makes an explicitly new Mail Hero event a distinct Todoist
	// request while every retry of this same event keeps the exact same input.
	output.WriteString("\n\nMail Hero event: ")
	output.WriteString(event.EventID)
	return output.String(), nil
}

func (i *mailInbox) summarize(ctx context.Context, row *mailInboxRow, clients ClientProvider) error {
	claimed, err := i.transition(ctx, row, "pending", "summarizing")
	if err != nil || !claimed {
		return err
	}
	var event mailReceivedEvent
	if err = json.Unmarshal(row.payload, &event); err != nil {
		return i.postpone(ctx, row, "pending", "invalid_saved_event")
	}
	if strings.HasPrefix(event.Message.Subject, utils.SystemAutomaticallyEmailPrefix) {
		_, err = i.db.ExecContext(
			ctx,
			`UPDATE mail_inbox_events SET state='ignored',payload=NULL,updated_at=?
			WHERE source_id=? AND event_id=? AND state='summarizing'`,
			time.Now().Unix(),
			row.sourceID,
			row.eventID,
		)
		return err
	}
	llm, ok := clients.GetClient("llm").(pb.LLMSummaryServiceClient)
	if !ok {
		return i.postpone(ctx, row, "pending", "llm_client_unavailable")
	}
	callCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	response, callErr := llm.Summarize(callCtx, &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Prompt:      utils.DefaultPromptToSummaryEmail,
		Text:        mailSummaryInput(event),
	})
	cancel()
	if callErr != nil || response == nil || strings.TrimSpace(response.Summary) == "" {
		return i.postpone(ctx, row, "pending", "summary_failed")
	}
	summary := mailSummaryTag.ReplaceAllString(response.Summary, "<removed tag>")
	body, err := renderMailTodoBody(event, summary)
	if err != nil {
		return i.postpone(ctx, row, "pending", "summary_render_failed")
	}
	_, err = i.db.ExecContext(
		ctx,
		`UPDATE mail_inbox_events SET state='summarized',summary=?,summary_model=?,todo_body=?,
		attempt_count=0,next_attempt_at=0,last_error_code='',updated_at=?
		WHERE source_id=? AND event_id=? AND state='summarizing'`,
		summary,
		int32(response.Model),
		body,
		time.Now().Unix(),
		row.sourceID,
		row.eventID,
	)
	return err
}

func (i *mailInbox) createTodo(ctx context.Context, row *mailInboxRow, clients ClientProvider) error {
	var event mailReceivedEvent
	if err := json.Unmarshal(row.payload, &event); err != nil {
		return i.postpone(ctx, row, "summarized", "invalid_saved_event")
	}
	todoClient, ok := clients.GetClient("todo").(pb.TodoServiceClient)
	if !ok {
		return i.postpone(ctx, row, "summarized", "todo_client_unavailable")
	}
	claimed, err := i.transition(ctx, row, "summarized", "todo_sending")
	if err != nil || !claimed {
		return err
	}
	from, _, _ := mailEventLabels(event)
	// mail.received.v1 allows a body-only message, but Todoist requires a
	// nonempty task title. Keep the original subject in the archived event.
	subject := event.Message.Subject
	if strings.TrimSpace(subject) == "" {
		subject = "(No subject)"
	}
	callCtx, cancel := context.WithTimeout(ctx, 40*time.Second)
	response, callErr := todoClient.PopulateTodo(callCtx, &pb.TodoRequest{
		App: pb.TodoApp_TODO_APP_TODOIST, Method: pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_TODOIST,
		Subject: subject, Body: row.todoBody, From: from,
	})
	cancel()
	if callErr != nil || response == nil || response.Id == "" {
		_, err = i.db.ExecContext(
			ctx,
			`UPDATE mail_inbox_events SET state='todo_unknown',last_error_code='todo_result_unknown',updated_at=?
			WHERE source_id=? AND event_id=? AND state='todo_sending'`,
			time.Now().Unix(),
			row.sourceID,
			row.eventID,
		)
		return err
	}
	_, err = i.db.ExecContext(ctx, `UPDATE mail_inbox_events SET state='todo_created',task_id=?,next_attempt_at=0,
		last_error_code='',updated_at=? WHERE source_id=? AND event_id=? AND state='todo_sending'`,
		response.Id, time.Now().Unix(), row.sourceID, row.eventID)
	return err
}

func (i *mailInbox) writeLegacyCache(ctx context.Context, row *mailInboxRow, clients ClientProvider) error {
	var event mailReceivedEvent
	if err := json.Unmarshal(row.payload, &event); err != nil {
		return i.postpone(ctx, row, "todo_created", "invalid_saved_event")
	}
	databaseClient, ok := clients.GetClient("database").(pb.DataBaseServiceClient)
	if !ok {
		return i.postpone(ctx, row, "todo_created", "database_client_unavailable")
	}
	// Keep the Mail Hero cache namespace separate from the old CloudMailin
	// content hash. Replaying this event updates only its own cache row.
	hash := sha256.Sum256([]byte(row.sourceID + "\x00" + row.eventID))
	callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	_, callErr := databaseClient.Write(callCtx, &pb.WriteRequest{
		Type: pb.DatabaseType_DATABASE_TYPE_SQLITE,
		Schema: &pb.DataBaseSchema{
			ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
			Model:       pb.Model(row.model),
			Prompt:      utils.DefaultPromptToSummaryEmail,
			Text:        mailSummaryInput(event),
			Summary:     row.todoBody,
			HashId:      fmt.Sprintf("mailhero-v1-%x", hash[:]),
		},
	})
	cancel()
	if callErr != nil {
		return i.postpone(ctx, row, "todo_created", "cache_write_failed")
	}
	_, err := i.db.ExecContext(
		ctx,
		`UPDATE mail_inbox_events SET state='complete',payload=NULL,summary='',
		todo_body='',last_error_code='',updated_at=?
		WHERE source_id=? AND event_id=? AND state='todo_created'`,
		time.Now().Unix(),
		row.sourceID,
		row.eventID,
	)
	return err
}

// processMailInboxOne advances one durable stage. The Todoist stage is only
// entered after the exact rendered task body has already been committed.
func (i *mailInbox) processOne(ctx context.Context, clients ClientProvider) (bool, error) {
	row, err := i.nextDue(ctx)
	if err != nil || row == nil {
		return false, err
	}
	switch row.state {
	case "pending":
		err = i.summarize(ctx, row, clients)
	case "summarized":
		err = i.createTodo(ctx, row, clients)
	case "todo_created":
		err = i.writeLegacyCache(ctx, row, clients)
	}
	return true, err
}

func (i *mailInbox) runWorker(ctx context.Context, clients ClientProvider) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		processed, err := i.processOne(ctx, clients)
		if err != nil && ctx.Err() == nil {
			// After a failed checkpoint write, a completed external request must
			// never be sent again. Recovery makes its uncertainty visible.
			_, _ = i.db.ExecContext(
				ctx,
				`UPDATE mail_inbox_events SET state='todo_unknown',last_error_code='checkpoint_failed',updated_at=?
				WHERE source_id=? AND state='todo_sending'`,
				time.Now().Unix(),
				i.sourceID,
			)
			_, _ = i.db.ExecContext(
				ctx,
				`UPDATE mail_inbox_events SET state='pending',updated_at=? WHERE source_id=? AND state='summarizing'`,
				time.Now().Unix(),
				i.sourceID,
			)
			log.Error("mail inbox worker encountered a storage error")
		}
		if processed && err == nil {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (i *mailInbox) handleStatus(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	rows, err := i.db.QueryContext(
		c.Request.Context(),
		`SELECT event_id,state,task_id,attempt_count,last_error_code,created_at,updated_at
		FROM mail_inbox_events WHERE source_id=? ORDER BY created_at DESC,event_id DESC LIMIT 100`,
		i.sourceID,
	)
	if err != nil {
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return
	}
	defer func() { _ = rows.Close() }()
	items := make([]gin.H, 0)
	for rows.Next() {
		var eventID, state, taskID, code string
		var attempts int
		var created, updated int64
		if err = rows.Scan(&eventID, &state, &taskID, &attempts, &code, &created, &updated); err != nil {
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
		items = append(items, gin.H{"event_id": eventID, "state": state, "task_id": taskID,
			"attempt_count": attempts, "error_code": code,
			"received_at": time.Unix(created, 0).UTC(), "updated_at": time.Unix(updated, 0).UTC()})
	}
	if rows.Err() != nil {
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

type mailReconcileRequest struct {
	EventID         string `json:"event_id"`
	Resolution      string `json:"resolution"`
	TaskID          string `json:"task_id"`
	ConfirmedNoTask bool   `json:"confirmed_no_task"`
}

// handleReconcile is an explicit owner action for uncertain Todoist results.
// A custom header prevents ordinary cross-site forms from reaching this
// BasicAuth-protected endpoint; it is never called by Mail Hero's webhook.
func (i *mailInbox) handleReconcile(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	eventID := c.Param("event_id")
	if c.GetHeader("X-Todofy-Admin-Action") != "reconcile-mail-inbox" || !mailEventUUID.MatchString(eventID) {
		c.AbortWithStatus(http.StatusForbidden)
		return
	}
	var body mailReconcileRequest
	decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil || body.EventID != eventID {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	var result sql.Result
	var err error
	now := time.Now().Unix()
	switch body.Resolution {
	case "task_created":
		if strings.TrimSpace(body.TaskID) == "" || len(body.TaskID) > 128 {
			c.AbortWithStatus(http.StatusBadRequest)
			return
		}
		result, err = i.db.ExecContext(
			c.Request.Context(),
			`UPDATE mail_inbox_events SET state='todo_created',task_id=?,
			next_attempt_at=0,last_error_code='',updated_at=? WHERE source_id=? AND event_id=? AND state='todo_unknown'`,
			body.TaskID,
			now,
			i.sourceID,
			eventID,
		)
	case "task_not_created":
		if !body.ConfirmedNoTask {
			c.AbortWithStatus(http.StatusBadRequest)
			return
		}
		result, err = i.db.ExecContext(c.Request.Context(), `UPDATE mail_inbox_events SET state='summarized',
			next_attempt_at=0,last_error_code='',updated_at=? WHERE source_id=? AND event_id=? AND state='todo_unknown'`,
			now, i.sourceID, eventID)
	case "retry_summary":
		result, err = i.db.ExecContext(
			c.Request.Context(),
			`UPDATE mail_inbox_events SET state='pending',attempt_count=0,
			next_attempt_at=0,last_error_code='',updated_at=? WHERE source_id=? AND event_id=? AND state='failed_summary'`,
			now,
			i.sourceID,
			eventID,
		)
	default:
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	if err != nil {
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return
	}
	changed, err := result.RowsAffected()
	if err != nil || changed != 1 {
		c.AbortWithStatus(http.StatusConflict)
		return
	}
	c.Status(http.StatusNoContent)
}
