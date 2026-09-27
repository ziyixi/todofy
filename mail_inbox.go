package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"
)

const mailEventMaxBytes = 1 << 20

var mailEventUUID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type mailAddress struct {
	Address string `json:"address"`
	Name    string `json:"name"`
}

type mailAttachment struct {
	Filename      string `json:"filename"`
	ContentType   string `json:"content_type"`
	Size          int64  `json:"size"`
	StorageStatus string `json:"storage_status,omitempty"`
	OmittedReason string `json:"omitted_reason,omitempty"`
}

type mailReceivedEvent struct {
	Type       string    `json:"type"`
	EventID    string    `json:"event_id"`
	ReceivedAt time.Time `json:"received_at"`
	Message    struct {
		ID                      string           `json:"id"`
		From                    []mailAddress    `json:"from"`
		To                      []mailAddress    `json:"to"`
		Subject                 string           `json:"subject"`
		SentAt                  *time.Time       `json:"sent_at"`
		RFCMessageID            *string          `json:"rfc_message_id"`
		Text                    string           `json:"text"`
		Attachments             []mailAttachment `json:"attachments"`
		TextTruncated           bool             `json:"text_truncated,omitempty"`
		OriginalTextBytes       *int64           `json:"original_text_bytes,omitempty"`
		HTMLOmitted             bool             `json:"html_omitted,omitempty"`
		NeedsReview             bool             `json:"needs_review,omitempty"`
		AttachmentsOmittedCount int              `json:"attachments_omitted_count,omitempty"`
		ContentPolicyVersion    string           `json:"content_policy_version,omitempty"`
		Warnings                []string         `json:"warnings,omitempty"`
	} `json:"message"`
}

func parseMailReceivedEvent(raw []byte) (mailReceivedEvent, error) {
	var event mailReceivedEvent
	if len(raw) == 0 || len(raw) > mailEventMaxBytes || !json.Valid(raw) {
		return event, errors.New("invalid JSON body")
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil || top == nil {
		return event, errors.New("invalid event object")
	}
	for _, field := range []string{"type", "event_id", "received_at", "message"} {
		if _, present := top[field]; !present {
			return event, errors.New("missing event field")
		}
	}
	var messageFields map[string]json.RawMessage
	if err := json.Unmarshal(top["message"], &messageFields); err != nil || messageFields == nil {
		return event, errors.New("invalid message object")
	}
	for _, field := range []string{"id", "from", "to", "subject", "sent_at", "rfc_message_id", "text", "attachments"} {
		if _, present := messageFields[field]; !present {
			return event, errors.New("missing message field")
		}
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		return event, errors.New("invalid event structure")
	}
	if event.Type != "mail.received.v1" || !mailEventUUID.MatchString(event.EventID) ||
		!mailEventUUID.MatchString(event.Message.ID) || event.ReceivedAt.IsZero() ||
		(strings.TrimSpace(event.Message.Subject) == "" && strings.TrimSpace(event.Message.Text) == "") ||
		len(event.Message.Subject) > 4096 || len(event.Message.Text) > 256<<10 ||
		len(event.Message.From) > 50 || len(event.Message.To) > 50 || len(event.Message.Attachments) > 100 {
		return event, errors.New("unsupported mail.received.v1 event")
	}
	return event, validateMailContentPolicy(event)
}

func validateMailContentPolicy(event mailReceivedEvent) error {
	// New policy metadata is optional for older frozen events, but a sender
	// cannot label an incomplete body as complete through inconsistent sizes.
	original := event.Message.OriginalTextBytes
	if event.Message.AttachmentsOmittedCount < 0 ||
		(original != nil && (*original < int64(len(event.Message.Text)) ||
			(!event.Message.TextTruncated && *original != int64(len(event.Message.Text))))) ||
		(event.Message.TextTruncated && (original == nil || *original <= int64(len(event.Message.Text)))) {
		return errors.New("invalid content policy metadata")
	}
	for _, attachment := range event.Message.Attachments {
		if attachment.Size < 0 {
			return errors.New("invalid attachment size")
		}
		if attachment.StorageStatus != "" && attachment.StorageStatus != "stored" && attachment.StorageStatus != "omitted" {
			return errors.New("invalid attachment storage status")
		}
	}
	return nil
}

type mailInbox struct {
	db        *sql.DB
	lock      *os.File
	sourceID  string
	tokenFile string
	remind    bool
	// now is nil in production; tests inject a clock for day and retry windows.
	now             func() time.Time
	remindCheckedAt time.Time
}

func (i *mailInbox) clock() time.Time {
	if i.now != nil {
		return i.now()
	}
	return time.Now()
}

func mailReminderEnabled(value string) (bool, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return true, nil
	}
	enabled, err := strconv.ParseBool(value)
	if err != nil {
		return false, errors.New("TODOFY_MAIL_ATTENTION_REMINDER must be true or false")
	}
	return enabled, nil
}

func validateMailInboxConfig(cfg Config) error {
	values := []string{cfg.MailInboxPath, cfg.MailWebhookTokenFile, cfg.MailSourceID}
	count := 0
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			count++
		}
	}
	if count == 0 {
		return nil
	}
	if count != len(values) || !filepath.IsAbs(cfg.MailInboxPath) || !filepath.IsAbs(cfg.MailWebhookTokenFile) ||
		strings.ContainsAny(cfg.MailSourceID, "\r\n\x00") || len(cfg.MailSourceID) > 128 {
		return errors.New("mail inbox requires an absolute path, an absolute token file, and a stable source ID")
	}
	_, err := mailReminderEnabled(cfg.MailAttentionReminder)
	return err
}

func readMailWebhookToken(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	token := []byte(strings.TrimSpace(string(data)))
	if len(token) < 32 || len(token) > 4096 || strings.ContainsAny(string(token), "\r\n\x00") {
		return nil, errors.New("webhook token must be 32-4096 single-line bytes")
	}
	return token, nil
}

func openMailInbox(cfg Config) (*mailInbox, error) {
	if err := validateMailInboxConfig(cfg); err != nil {
		return nil, err
	}
	if _, err := readMailWebhookToken(cfg.MailWebhookTokenFile); err != nil {
		return nil, fmt.Errorf("mail webhook token file is unusable: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(cfg.MailInboxPath), 0700); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(cfg.MailInboxPath+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = lock.Close()
		return nil, errors.New("mail inbox is already open by another Todofy instance")
	}
	precreated, err := os.OpenFile(cfg.MailInboxPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		_ = lock.Close()
		return nil, err
	}
	_ = precreated.Close()
	uri := (&url.URL{Scheme: "file", Path: cfg.MailInboxPath}).String()
	db, err := sql.Open("sqlite3", uri+"?_busy_timeout=5000&_journal_mode=WAL&_synchronous=FULL")
	if err != nil {
		_ = lock.Close()
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	remind, _ := mailReminderEnabled(cfg.MailAttentionReminder)
	inbox := &mailInbox{db: db, lock: lock, sourceID: cfg.MailSourceID, tokenFile: cfg.MailWebhookTokenFile,
		remind: remind}
	if err = inbox.initialize(context.Background()); err != nil {
		_ = inbox.Close()
		return nil, err
	}
	return inbox, nil
}

func (i *mailInbox) initialize(ctx context.Context) error {
	var journalMode string
	var synchronous int
	if err := i.db.QueryRowContext(ctx, `PRAGMA journal_mode=WAL`).Scan(&journalMode); err != nil {
		return err
	}
	if err := i.db.QueryRowContext(ctx, `PRAGMA synchronous`).Scan(&synchronous); err != nil {
		return err
	}
	if journalMode != "wal" || synchronous != 2 {
		return errors.New("mail inbox SQLite durable settings are not active")
	}
	_, err := i.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mail_inbox_events (
		source_id TEXT NOT NULL,
		event_id TEXT NOT NULL,
		payload_hash BLOB NOT NULL,
		payload BLOB,
		state TEXT NOT NULL CHECK(state IN (
			'pending','summarizing','summarized','todo_sending','todo_unknown',
			'todo_created','complete','ignored','failed_summary')),
		summary TEXT NOT NULL DEFAULT '',
		summary_model INTEGER NOT NULL DEFAULT 0,
		todo_body TEXT NOT NULL DEFAULT '',
		task_id TEXT NOT NULL DEFAULT '',
		attempt_count INTEGER NOT NULL DEFAULT 0,
		next_attempt_at INTEGER NOT NULL DEFAULT 0,
		last_error_code TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY(source_id,event_id)
	);
	CREATE INDEX IF NOT EXISTS mail_inbox_due ON mail_inbox_events(state,next_attempt_at,created_at);
	CREATE INDEX IF NOT EXISTS mail_inbox_state ON mail_inbox_events(source_id,state);
	CREATE INDEX IF NOT EXISTS mail_inbox_active ON mail_inbox_events(source_id,created_at,event_id)
		WHERE `+mailActiveSQL+`;
	CREATE TABLE IF NOT EXISTS mail_inbox_reminders (
		day TEXT PRIMARY KEY,
		state TEXT NOT NULL CHECK(state IN ('sending','created','unknown','failed')),
		task_id TEXT NOT NULL DEFAULT '',
		subject TEXT NOT NULL DEFAULT '',
		body TEXT NOT NULL DEFAULT '',
		attention_count INTEGER NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_attempt_at INTEGER NOT NULL DEFAULT 0,
		last_error_code TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);`)
	if err != nil {
		return err
	}
	var otherSources int
	err = i.db.QueryRowContext(ctx, `SELECT count(*) FROM mail_inbox_events WHERE source_id<>?`,
		i.sourceID).Scan(&otherSources)
	if err != nil {
		return err
	}
	if otherSources != 0 {
		return errors.New("mail source ID differs from the durable inbox; use the existing stable ID")
	}
	// LLM can be called again after a crash. A Todoist call may already have
	// succeeded, so its interrupted state must never be replayed automatically.
	_, err = i.db.ExecContext(
		ctx,
		`UPDATE mail_inbox_events SET state='pending',updated_at=? WHERE source_id=? AND state='summarizing'`,
		time.Now().Unix(),
		i.sourceID,
	)
	if err != nil {
		return err
	}
	_, err = i.db.ExecContext(
		ctx,
		`UPDATE mail_inbox_events SET state='todo_unknown',last_error_code='interrupted_todo_call',updated_at=?
		WHERE source_id=? AND state='todo_sending'`,
		time.Now().Unix(),
		i.sourceID,
	)
	if err != nil {
		return err
	}
	// A reminder task may already exist; a missed reminder beats a duplicate.
	_, err = i.db.ExecContext(ctx, `UPDATE mail_inbox_reminders SET state='unknown',
		last_error_code='interrupted_reminder_call',updated_at=? WHERE state='sending'`, time.Now().Unix())
	return err
}

func (i *mailInbox) Close() error {
	var err error
	if i.db != nil {
		err = i.db.Close()
	}
	if i.lock != nil {
		_ = syscall.Flock(int(i.lock.Fd()), syscall.LOCK_UN)
		_ = i.lock.Close()
	}
	return err
}

func (i *mailInbox) authenticated(c *gin.Context) bool {
	values := c.Request.Header.Values("Authorization")
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return false
	}
	want, err := readMailWebhookToken(i.tokenFile)
	if err != nil {
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return false
	}
	got := strings.TrimPrefix(values[0], "Bearer ")
	wantHash := sha256.Sum256(want)
	gotHash := sha256.Sum256([]byte(got))
	return subtle.ConstantTimeCompare(wantHash[:], gotHash[:]) == 1
}

func (i *mailInbox) handleWebhook(c *gin.Context) {
	if !i.authenticated(c) {
		if !c.IsAborted() {
			c.AbortWithStatus(http.StatusUnauthorized)
		}
		return
	}
	contentType, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || contentType != "application/json" {
		c.AbortWithStatus(http.StatusUnsupportedMediaType)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, mailEventMaxBytes))
	if err != nil {
		c.AbortWithStatus(http.StatusRequestEntityTooLarge)
		return
	}
	event, err := parseMailReceivedEvent(raw)
	if err != nil || c.GetHeader("Idempotency-Key") != event.EventID ||
		len(c.Request.Header.Values("Idempotency-Key")) != 1 {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	hash := sha256.Sum256(raw)
	now := time.Now().Unix()
	_, err = i.db.ExecContext(
		c.Request.Context(),
		`INSERT OR IGNORE INTO mail_inbox_events(source_id,event_id,payload_hash,payload,state,created_at,updated_at)
		VALUES(?,?,?,?,'pending',?,?)`,
		i.sourceID,
		event.EventID,
		hash[:],
		raw,
		now,
		now,
	)
	if err != nil {
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return
	}
	var stored []byte
	err = i.db.QueryRowContext(c.Request.Context(),
		`SELECT payload_hash FROM mail_inbox_events WHERE source_id=? AND event_id=?`,
		i.sourceID, event.EventID).Scan(&stored)
	if err != nil {
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return
	}
	if subtle.ConstantTimeCompare(stored, hash[:]) != 1 {
		c.AbortWithStatus(http.StatusConflict)
		return
	}
	c.Status(http.StatusNoContent)
}
