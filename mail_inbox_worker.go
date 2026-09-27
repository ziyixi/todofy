package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
	"github.com/ziyixi/todofy/utils"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/ziyixi/protos/go/todofy"
)

var mailSummaryTag = regexp.MustCompile(`\s#[a-zA-Z0-9]{1,10}\s`)

type mailInboxRow struct {
	sourceID  string
	eventID   string
	state     string
	payload   []byte
	summary   string
	model     int32
	todoBody  string
	taskID    string
	attempts  int
	createdAt int64
}

func (i *mailInbox) nextDue(ctx context.Context) (*mailInboxRow, error) {
	row := new(mailInboxRow)
	err := i.db.QueryRowContext(ctx, `SELECT source_id,event_id,state,payload,summary,
		summary_model,todo_body,task_id,attempt_count,created_at FROM mail_inbox_events
		WHERE source_id=? AND state IN ('pending','summarized','todo_created') AND next_attempt_at<=?
		ORDER BY created_at,event_id LIMIT 1`, i.sourceID, i.clock().Unix()).
		Scan(
			&row.sourceID, &row.eventID, &row.state, &row.payload, &row.summary,
			&row.model, &row.todoBody, &row.taskID, &row.attempts, &row.createdAt,
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

const (
	mailStatePending       = "pending"
	mailSummaryRetryWindow = 7 * 24 * time.Hour
)

// mailSummaryGivesUp keeps transient LLM outages or quota exhaustion on the
// capped ~4-hourly retry for a week; a bad saved event cannot heal by waiting.
func mailSummaryGivesUp(row *mailInboxRow, safeCode string, now time.Time) bool {
	if row.attempts < 12 {
		return false
	}
	switch safeCode {
	case "summary_failed", "llm_client_unavailable":
		return now.Sub(time.Unix(row.createdAt, 0)) >= mailSummaryRetryWindow
	}
	return true
}

func (i *mailInbox) postpone(ctx context.Context, row *mailInboxRow, state, safeCode string) error {
	now := i.clock()
	next := now.Add(mailRetryDelay(row.attempts)).Unix()
	if state == mailStatePending && mailSummaryGivesUp(row, safeCode, now) {
		state = "failed_summary"
		next = 0
	}
	_, err := i.db.ExecContext(ctx, `UPDATE mail_inbox_events SET state=?,attempt_count=attempt_count+1,
		next_attempt_at=?,last_error_code=?,updated_at=? WHERE source_id=? AND event_id=?`,
		state, next, safeCode, now.Unix(), row.sourceID, row.eventID)
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
	text := event.Message.Subject
	if strings.TrimSpace(event.Message.Text) != "" {
		text = event.Message.Text
	}
	if event.Message.TextTruncated {
		return mailContentNotice(event) + "\n\n" + text
	}
	return text
}

func mailContentNotice(event mailReceivedEvent) string {
	if !event.Message.TextTruncated {
		return ""
	}
	if event.Message.OriginalTextBytes == nil {
		return "正文不完整：仅收到邮件正文的前部，摘要可能遗漏尾部内容。"
	}
	return fmt.Sprintf("正文不完整：原文 %d bytes，仅收到前 %d bytes，摘要可能遗漏尾部内容。",
		*event.Message.OriginalTextBytes, len(event.Message.Text))
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
	// Durable acceptance is separate from business success. Do not turn an
	// unreadable HTML body or opaque MIME content into an invented empty task.
	if event.Message.NeedsReview || (event.Message.HTMLOmitted && strings.TrimSpace(event.Message.Text) == "") {
		_, err = i.db.ExecContext(ctx, `UPDATE mail_inbox_events SET state='failed_summary',
			last_error_code='mail_needs_review',next_attempt_at=0,updated_at=?
			WHERE source_id=? AND event_id=? AND state='summarizing'`,
			time.Now().Unix(), row.sourceID, row.eventID)
		return err
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
	if event.Message.TextTruncated {
		// Persist the notice independently of the model's output so both the
		// summary cache and Todoist task disclose the incomplete source.
		summary = mailContentNotice(event) + "\n\n" + summary
	}
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
	case mailStatePending:
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
		if err == nil {
			i.remindIfDue(ctx, clients)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Terminal failures need the owner at once; in-flight work only after it has
// outlived normal LLM and Todoist retries.
const mailAttentionSQL = `(state IN ('failed_summary','todo_unknown') OR
	(state IN ('pending','summarizing','summarized','todo_sending','todo_created') AND created_at<=?))`

// mailActiveSQL must stay textually identical in the mail_inbox_active partial
// index and its queries, or SQLite falls back to scanning the whole ledger.
const mailActiveSQL = `state NOT IN ('complete','ignored')`

const (
	mailStatusColumnsSQL = `SELECT event_id,state,task_id,attempt_count,last_error_code,created_at,updated_at
		FROM mail_inbox_events WHERE source_id=?`
	mailAttentionListSQL = mailStatusColumnsSQL + ` AND ` + mailActiveSQL + ` AND ` + mailAttentionSQL +
		` ORDER BY created_at,event_id LIMIT ?`
	mailAttentionCountSQL = `SELECT count(*) FROM mail_inbox_events WHERE source_id=? AND ` + mailActiveSQL +
		` AND ` + mailAttentionSQL
	mailStateCountsSQL = `SELECT state,count(*) FROM mail_inbox_events WHERE source_id=? GROUP BY state`
)

const (
	mailAttentionAge  = 6 * time.Hour
	mailViewRecent    = "recent"
	mailViewAttention = "attention"
)

var mailInboxStates = []string{
	mailStatePending, "summarizing", "summarized", "todo_sending", "todo_unknown",
	"todo_created", "complete", "ignored", "failed_summary",
}

func mailAttentionCutoff(now time.Time) int64 {
	return now.Add(-mailAttentionAge).Unix()
}

// attentionCount reads only non-terminal rows; the ledger is never pruned.
func (i *mailInbox) attentionCount(ctx context.Context, now time.Time) (int, error) {
	var count int
	err := i.db.QueryRowContext(ctx, mailAttentionCountSQL, i.sourceID, mailAttentionCutoff(now)).Scan(&count)
	return count, err
}

func (i *mailInbox) stateCounts(ctx context.Context) (map[string]int, error) {
	counts := make(map[string]int, len(mailInboxStates))
	for _, state := range mailInboxStates {
		counts[state] = 0
	}
	rows, err := i.db.QueryContext(ctx, mailStateCountsSQL, i.sourceID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var state string
		var count int
		if err = rows.Scan(&state, &count); err != nil {
			return nil, err
		}
		counts[state] = count
	}
	return counts, rows.Err()
}

type mailStatusItem struct {
	eventID, state, taskID, code string
	attempts                     int
	created, updated             int64
}

// mailStatusItems never reads payload, summary or rendered task columns.
func (i *mailInbox) mailStatusItems(
	ctx context.Context, attention bool, now time.Time, limit int,
) ([]mailStatusItem, error) {
	query := mailStatusColumnsSQL + ` ORDER BY created_at DESC,event_id DESC LIMIT ?`
	args := []any{i.sourceID, limit}
	if attention {
		query = mailAttentionListSQL
		args = []any{i.sourceID, mailAttentionCutoff(now), limit}
	}
	rows, err := i.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	items := make([]mailStatusItem, 0)
	for rows.Next() {
		var item mailStatusItem
		if err = rows.Scan(&item.eventID, &item.state, &item.taskID, &item.attempts, &item.code,
			&item.created, &item.updated); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (i *mailInbox) handleStatus(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	view := c.Query("view")
	if len(c.QueryArray("view")) > 1 || (view != "" && view != mailViewRecent && view != mailViewAttention) {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	ctx, now, attentionView := c.Request.Context(), i.clock(), view == mailViewAttention
	limit := 100
	if attentionView {
		limit = 500
	}
	items, err := i.mailStatusItems(ctx, attentionView, now, limit)
	if err != nil {
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return
	}
	counts, err := i.stateCounts(ctx)
	if err != nil {
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return
	}
	attention, err := i.attentionCount(ctx, now)
	if err != nil {
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return
	}
	reminder, err := i.latestReminder(ctx)
	if err != nil {
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return
	}
	out := make([]gin.H, 0, len(items))
	for _, item := range items {
		out = append(out, gin.H{"event_id": item.eventID, "state": item.state, "task_id": item.taskID,
			"attempt_count": item.attempts, "error_code": item.code,
			"received_at": time.Unix(item.created, 0).UTC(), "updated_at": time.Unix(item.updated, 0).UTC()})
	}
	c.JSON(http.StatusOK, gin.H{"items": out, "counts": counts, "attention_count": attention,
		"latest_reminder": reminder})
}

type mailReminderStatus struct {
	Day       string `json:"day"`
	State     string `json:"state"`
	TaskID    string `json:"task_id"`
	Attempts  int    `json:"attempts"`
	ErrorCode string `json:"error_code"`
}

// latestReminder makes a broken Todoist path visible without Todoist itself.
func (i *mailInbox) latestReminder(ctx context.Context) (*mailReminderStatus, error) {
	var out mailReminderStatus
	err := i.db.QueryRowContext(ctx, `SELECT day,state,task_id,attempts,last_error_code FROM mail_inbox_reminders
		ORDER BY day DESC LIMIT 1`).Scan(&out.Day, &out.State, &out.TaskID, &out.Attempts, &out.ErrorCode)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

const (
	mailReminderCheckInterval = 10 * time.Minute
	mailReminderRetryDelay    = time.Hour
	mailReminderMaxAttempts   = 5
	mailReminderListLimit     = 20
)

const mailReminderInstructions = "\n处理方法：\n" +
	"1. 用 Todofy 的 BasicAuth 调用 `GET /api/v1/mail_inbox?view=attention` 查看全部待处理事件。\n" +
	"2. 逐条调用 `POST /api/v1/mail_inbox/<event_id>/reconcile`，请求头 " +
	"`X-Todofy-Admin-Action: reconcile-mail-inbox`，JSON 含 `event_id` 和 `resolution`：\n" +
	"   - `task_created`：Todoist 已有含 `Mail Hero event: <event_id>` 的任务，同时提供 `task_id`；\n" +
	"   - `task_not_created`：已确认没有任务，需 `confirmed_no_task: true`，会重新创建任务；\n" +
	"   - `retry_summary`：重新摘要 `failed_summary` 事件；\n" +
	"   - `dismiss`：放弃 `failed_summary` 或 `todo_unknown` 事件，需 `confirmed_dismiss: true`。\n" +
	"3. 超过 6 小时仍在处理中的事件多半仍在自动重试，可先查看错误码。\n\n" +
	"此提醒每个 UTC 日最多创建一次。"

// remindIfDue runs only on the worker goroutine, so the timer needs no lock.
func (i *mailInbox) remindIfDue(ctx context.Context, clients ClientProvider) {
	now := i.clock()
	elapsed := now.Sub(i.remindCheckedAt)
	if !i.remindCheckedAt.IsZero() && elapsed >= 0 && elapsed < mailReminderCheckInterval {
		return
	}
	i.remindCheckedAt = now
	if err := i.maybeRemind(ctx, clients); err != nil && ctx.Err() == nil {
		log.Error("mail inbox reminder encountered a storage error")
	}
}

// maybeRemind creates at most one owner reminder task per UTC day. The first
// claim freezes the exact request, so a retry keeps the todo service's Todoist
// X-Request-Id, and only a failure that cannot have created a task is retried.
func (i *mailInbox) maybeRemind(ctx context.Context, clients ClientProvider) error {
	if !i.remind {
		return nil
	}
	now := i.clock()
	day := now.UTC().Format(time.DateOnly)
	var state, subject, body string
	var attempts int
	var next int64
	err := i.db.QueryRowContext(ctx, `SELECT state,attempts,next_attempt_at,subject,body FROM mail_inbox_reminders
		WHERE day=?`, day).Scan(&state, &attempts, &next, &subject, &body)
	exists := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	// A settled day stays a primary-key read on every idle check.
	if exists && (state != "failed" || attempts >= mailReminderMaxAttempts || next > now.Unix()) {
		return nil
	}
	attention, err := i.attentionCount(ctx, now)
	if err != nil || attention == 0 {
		return err
	}
	var claim sql.Result
	if exists {
		claim, err = i.db.ExecContext(ctx, `UPDATE mail_inbox_reminders SET state='sending',updated_at=?
			WHERE day=? AND state='failed' AND attempts=? AND next_attempt_at<=?`, now.Unix(), day, attempts, now.Unix())
	} else {
		subject = fmt.Sprintf("%s Mail Hero：%d 封邮件需要处理", utils.SystemAutomaticallyEmailPrefix, attention)
		if body, err = i.reminderBody(ctx, now, day, attention); err != nil {
			return err
		}
		claim, err = i.db.ExecContext(ctx, `INSERT INTO mail_inbox_reminders(day,state,subject,body,attention_count,
			created_at,updated_at) VALUES(?,'sending',?,?,?,?,?) ON CONFLICT(day) DO NOTHING`,
			day, subject, body, attention, now.Unix(), now.Unix())
	}
	if err != nil {
		return err
	}
	if claimed, err := claim.RowsAffected(); err != nil || claimed != 1 {
		return err
	}
	taskID, code := "", "todo_client_unavailable"
	if todoClient, ok := clients.GetClient("todo").(pb.TodoServiceClient); ok {
		callCtx, cancel := context.WithTimeout(ctx, 40*time.Second)
		response, callErr := todoClient.PopulateTodo(callCtx, &pb.TodoRequest{
			App: pb.TodoApp_TODO_APP_TODOIST, Method: pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_TODOIST,
			Subject: subject, Body: body, From: "todofy",
		})
		cancel()
		taskID, code = mailReminderOutcome(response, callErr)
	}
	return i.finishReminder(ctx, day, attempts+1, taskID, code, i.clock())
}

// mailReminderOutcome treats every result that may hide a created task like
// createTodo's todo_unknown: a timeout can land after Todoist accepted the task.
// Unavailable normally means the todo service was never reached; if a stream
// broke later, the frozen request still lets Todoist deduplicate the retry.
func mailReminderOutcome(response *pb.TodoResponse, callErr error) (taskID, code string) {
	switch {
	case callErr == nil && response != nil && response.Id != "":
		return response.Id, ""
	case callErr == nil:
		return "", "empty_task_id"
	}
	switch status.Code(callErr) {
	case codes.Unavailable, codes.InvalidArgument, codes.FailedPrecondition:
		return "", "reminder_create_failed"
	}
	return "", "reminder_result_unknown"
}

func (i *mailInbox) finishReminder(
	ctx context.Context, day string, attempt int, taskID, code string, now time.Time,
) error {
	if taskID != "" {
		_, err := i.db.ExecContext(ctx, `UPDATE mail_inbox_reminders SET state='created',task_id=?,
			last_error_code='',updated_at=? WHERE day=? AND state='sending'`, taskID, now.Unix(), day)
		return err
	}
	state := "unknown"
	if code == "todo_client_unavailable" || code == "reminder_create_failed" {
		state = "failed"
	}
	// Todoist is the owner's only alert channel, so its failure must be logged.
	log.WithFields(logrus.Fields{"reminder_day": day, "attempt": attempt, "state": state, "error_code": code}).
		Warn("mail inbox reminder not created")
	_, err := i.db.ExecContext(ctx, `UPDATE mail_inbox_reminders SET state=?,attempts=attempts+1,
		next_attempt_at=?,last_error_code=?,updated_at=? WHERE day=? AND state='sending'`,
		state, now.Add(mailReminderRetryDelay).Unix(), code, now.Unix(), day)
	return err
}

// reminderBody lists only event IDs, states, safe codes and arrival times:
// never subjects, addresses or mail text.
func (i *mailInbox) reminderBody(ctx context.Context, now time.Time, day string, attention int) (string, error) {
	items, err := i.mailStatusItems(ctx, true, now, mailReminderListLimit)
	if err != nil {
		return "", err
	}
	var body strings.Builder
	fmt.Fprintf(&body, "Todofy 的 Mail Hero 收件箱有 %d 个事件需要处理（UTC %s）：\n\n", attention, day)
	for _, item := range items {
		code := item.code
		if code == "" {
			code = "-"
		}
		fmt.Fprintf(&body, "- %s · %s · %s · 收到 %s\n", item.eventID, item.state, code,
			time.Unix(item.created, 0).UTC().Format(time.RFC3339))
	}
	if more := attention - len(items); more > 0 {
		fmt.Fprintf(&body, "- … 另有 %d 条\n", more)
	}
	body.WriteString(mailReminderInstructions)
	return body.String(), nil
}

type mailReconcileRequest struct {
	EventID          string `json:"event_id"`
	Resolution       string `json:"resolution"`
	TaskID           string `json:"task_id"`
	ConfirmedNoTask  bool   `json:"confirmed_no_task"`
	ConfirmedDismiss bool   `json:"confirmed_dismiss"`
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
			next_attempt_at=0,last_error_code='',updated_at=? WHERE source_id=? AND event_id=? AND state='failed_summary'
			AND last_error_code<>'mail_needs_review'`,
			now,
			i.sourceID,
			eventID,
		)
	case "dismiss":
		if !body.ConfirmedDismiss {
			c.AbortWithStatus(http.StatusBadRequest)
			return
		}
		// The event ID/hash ledger stays, so a redelivery is still deduplicated.
		result, err = i.db.ExecContext(c.Request.Context(), `UPDATE mail_inbox_events SET state='ignored',payload=NULL,
			summary='',todo_body='',last_error_code='dismissed_by_owner',next_attempt_at=0,updated_at=?
			WHERE source_id=? AND event_id=? AND state IN ('failed_summary','todo_unknown')`,
			now, i.sourceID, eventID)
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
