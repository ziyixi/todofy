package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/smtp"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/ziyixi/mail-hero/internal/config"
	"github.com/ziyixi/mail-hero/internal/delivery"
	"github.com/ziyixi/mail-hero/internal/ids"
	mailSMTP "github.com/ziyixi/mail-hero/internal/smtp"
	"github.com/ziyixi/mail-hero/internal/store"
	"github.com/ziyixi/mail-hero/internal/worker"
)

func TestSMTPToPostgreSQLParserAndRetryingWebhook(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	st := isolatedStore(t, ctx)
	pool := st.Pool()

	var receivedMu sync.Mutex
	var attempts []struct {
		key     string
		payload []byte
	}
	consumer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		receivedMu.Lock()
		attempts = append(attempts, struct {
			key     string
			payload []byte
		}{r.Header.Get("Idempotency-Key"), body})
		n := len(attempts)
		receivedMu.Unlock()
		if n == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer consumer.Close()
	endpointID, _ := ids.New()
	revisionID, _ := ids.New()
	if _, err := pool.Exec(ctx, `INSERT INTO webhook_endpoints(id,label) VALUES ($1,'Synthetic consumer')`, endpointID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type)
		VALUES ($1,$2,1,$3,'none')`, revisionID, endpointID, consumer.URL); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE webhook_endpoints SET current_revision_id=$1 WHERE id=$2`, revisionID, endpointID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE app_settings SET mode='forward',current_endpoint_id=$1 WHERE id=1`, endpointID); err != nil {
		t.Fatal(err)
	}

	receiver, err := mailSMTP.NewServer(config.Config{
		ReceiveAddress:    "hero@in.example.org",
		SMTPListenAddress: "127.0.0.1:0",
		AllowInsecureSMTP: true,
		MaxMessageBytes:   config.DefaultMaxMessageBytes,
	}, st)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- receiver.Serve(listener) }()
	defer func() {
		receiver.Close()
		select {
		case <-serveDone:
		case <-time.After(time.Second):
			t.Error("SMTP listener did not stop")
		}
	}()

	raw := []byte("From: Sender <sender@example.org>\r\nTo: hero@in.example.org\r\nSubject: Synthetic integration\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA task for the test consumer.\r\n")
	sendSynthetic(t, listener.Addr().String(), raw)
	var messageID, parseState, snapshotRevision string
	var persistedRaw []byte
	if err := pool.QueryRow(ctx, `SELECT id::text,parse_state,endpoint_revision_id::text,raw
		FROM messages WHERE origin='smtp'`).Scan(&messageID, &parseState, &snapshotRevision, &persistedRaw); err != nil {
		t.Fatal(err)
	}
	if parseState != "pending" || snapshotRevision != revisionID || !bytes.Equal(persistedRaw, raw) {
		t.Fatalf("SMTP 250 preceded wrong DB state: state=%s target=%s rawEqual=%v", parseState, snapshotRevision, bytes.Equal(persistedRaw, raw))
	}
	allowed := strings.TrimPrefix(consumer.URL, "http://")
	manager := &delivery.Manager{Pool: pool, Key: bytes.Repeat([]byte{7}, 32), ReceiveAddress: "hero@in.example.org", AllowedInternalTargets: []string{allowed}}
	w := &worker.Worker{Pool: pool, Delivery: manager}
	if worked, err := w.ParseOne(ctx); err != nil || !worked {
		t.Fatalf("parse: worked=%v error=%v", worked, err)
	}
	var eventID, eventState string
	var frozenPayload []byte
	if err := pool.QueryRow(ctx, `SELECT event_id::text,state,payload FROM deliveries WHERE message_id=$1`, messageID).Scan(&eventID, &eventState, &frozenPayload); err != nil {
		t.Fatal(err)
	}
	if eventState != "pending" || len(frozenPayload) == 0 {
		t.Fatalf("parser did not atomically create a sendable event: state=%s bytes=%d", eventState, len(frozenPayload))
	}
	var payloadObject struct {
		Type    string `json:"type"`
		EventID string `json:"event_id"`
	}
	if err := json.Unmarshal(frozenPayload, &payloadObject); err != nil || payloadObject.Type != "mail.received.v1" || payloadObject.EventID != eventID {
		t.Fatalf("unexpected generic webhook payload: %+v error=%v", payloadObject, err)
	}
	if worked, err := w.DeliverOne(ctx); err != nil || !worked {
		t.Fatalf("500 attempt: worked=%v error=%v", worked, err)
	}
	if err := pool.QueryRow(ctx, `SELECT state FROM deliveries WHERE event_id=$1`, eventID).Scan(&eventState); err != nil || eventState != "retry_wait" {
		t.Fatalf("500 did not persist retry_wait: state=%s error=%v", eventState, err)
	}
	// Advance only this isolated test queue; production backoff is unchanged.
	if _, err := pool.Exec(ctx, `UPDATE deliveries SET next_attempt_at=now()-interval '1 second' WHERE event_id=$1`, eventID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE webhook_endpoints SET next_send_at=now()-interval '1 second' WHERE id=$1`, endpointID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE app_settings SET next_send_at=now()-interval '1 second' WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if worked, err := w.DeliverOne(ctx); err != nil || !worked {
		t.Fatalf("204 attempt: worked=%v error=%v", worked, err)
	}
	var attemptCount int
	if err := pool.QueryRow(ctx, `SELECT state,attempt_count FROM deliveries WHERE event_id=$1`, eventID).Scan(&eventState, &attemptCount); err != nil || eventState != "delivered" || attemptCount != 2 {
		t.Fatalf("consumer 204 not persisted: state=%s count=%d error=%v", eventState, attemptCount, err)
	}
	receivedMu.Lock()
	if len(attempts) != 2 || attempts[0].key != eventID || attempts[1].key != eventID || !bytes.Equal(attempts[0].payload, frozenPayload) || !bytes.Equal(attempts[1].payload, frozenPayload) {
		t.Errorf("retry changed event ID or frozen bytes: attempts=%d", len(attempts))
	}
	receivedMu.Unlock()
	sendSynthetic(t, listener.Addr().String(), raw)
	var messageCount, arrivalCount, deliveryCount int
	if err := pool.QueryRow(ctx, `SELECT count(*),max(arrival_count) FROM messages WHERE origin='smtp'`).Scan(&messageCount, &arrivalCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM deliveries`).Scan(&deliveryCount); err != nil {
		t.Fatal(err)
	}
	if messageCount != 1 || arrivalCount != 2 || deliveryCount != 1 {
		t.Fatalf("SMTP retry duplicated message/event: messages=%d arrivals=%d events=%d", messageCount, arrivalCount, deliveryCount)
	}
}

func sendSynthetic(t *testing.T, address string, raw []byte) {
	t.Helper()
	client, err := smtp.Dial(address)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Mail("sender@example.org"); err != nil {
		t.Fatal(err)
	}
	if err := client.Rcpt("hero@in.example.org"); err != nil {
		t.Fatal(err)
	}
	writer, err := client.Data()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
}

func isolatedStore(t *testing.T, ctx context.Context) *store.Store {
	t.Helper()
	baseURL := os.Getenv("MAIL_HERO_TEST_DATABASE_URL")
	if baseURL == "" {
		t.Skip("set MAIL_HERO_TEST_DATABASE_URL for isolated PostgreSQL integration tests")
	}
	config, err := pgx.ParseConfig(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.ToLower(config.Database), "test") {
		t.Fatal("integration tests require a database whose name contains test")
	}
	admin, err := pgx.Connect(ctx, baseURL)
	if err != nil {
		t.Fatal(err)
	}
	uid, err := ids.New()
	if err != nil {
		admin.Close(context.Background())
		t.Fatal(err)
	}
	schema := "mailhero_test_" + strings.ReplaceAll(uid, "-", "")
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		admin.Close(context.Background())
		t.Fatal(err)
	}
	var st *store.Store
	t.Cleanup(func() {
		if st != nil {
			st.Close()
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := admin.Exec(cleanupCtx, "DROP SCHEMA "+quotedSchema+" CASCADE"); err != nil {
			t.Errorf("remove isolated integration schema: %v", err)
		}
		admin.Close(context.Background())
	})
	dsn, err := url.Parse(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	query := dsn.Query()
	query.Set("search_path", schema)
	dsn.RawQuery = query.Encode()
	st, err = store.Open(ctx, dsn.String())
	if err != nil {
		t.Fatal(err)
	}
	pool := st.Pool()
	migration, err := os.ReadFile("../../migrations/00001_initial.sql")
	if err != nil {
		t.Fatal(err)
	}
	up := strings.SplitN(string(migration), "-- +goose Down", 2)[0]
	if _, err := pool.Exec(ctx, up, pgx.QueryExecModeSimpleProtocol); err != nil {
		t.Fatal(fmt.Errorf("apply initial migration: %w", err))
	}
	return st
}
