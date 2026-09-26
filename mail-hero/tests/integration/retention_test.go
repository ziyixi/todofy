package integration_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/ziyixi/mail-hero/internal/ids"
	"github.com/ziyixi/mail-hero/internal/store"
)

func TestRetentionClearsOnlyTerminalContentAndPreservesTombstones(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	st := isolatedStore(t, ctx)
	pool := st.Pool()
	rawByID := map[string][]byte{}
	ingest := func(label string, old bool, parseState string) string {
		t.Helper()
		raw := []byte(fmt.Sprintf("From: sender@example.org\r\nSubject: %s\r\n\r\nSynthetic private body.\r\n", label))
		result, err := st.Ingest(ctx, store.IngestInput{EnvelopeFrom: "sender@example.org", Recipient: "hero@in.example.org", Raw: raw})
		if err != nil {
			t.Fatal(err)
		}
		rawByID[result.MessageID] = raw
		ageSQL := "now()"
		if old {
			ageSQL = "now()-interval '40 days'"
		}
		query := fmt.Sprintf(`UPDATE messages SET received_at=%s,last_received_at=%s,parse_state=$2,
			parsed_json='{"text":"Private parsed body"}'::jsonb,subject='Private subject',
			from_text='sender@example.org',search_text='Private searchable text' WHERE id=$1`, ageSQL, ageSQL)
		if _, err := pool.Exec(ctx, query, result.MessageID, parseState); err != nil {
			t.Fatal(err)
		}
		return result.MessageID
	}
	archived := ingest("archive-ready", true, "ready")
	failedParse := ingest("archive-parse-failed", true, "failed")
	recent := ingest("archive-recent", false, "ready")

	endpointID, _ := ids.New()
	revisionID, _ := ids.New()
	if _, err := pool.Exec(ctx, `INSERT INTO webhook_endpoints(id,label) VALUES($1,'Synthetic')`, endpointID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type)
		VALUES($1,$2,1,'https://example.invalid/hooks','none')`, revisionID, endpointID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE webhook_endpoints SET current_revision_id=$1 WHERE id=$2`, revisionID, endpointID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE app_settings SET mode='forward',current_endpoint_id=$1 WHERE id=1`, endpointID); err != nil {
		t.Fatal(err)
	}
	delivered := ingest("forward-delivered", true, "ready")
	pending := ingest("forward-pending", true, "ready")
	sending := ingest("forward-sending", true, "ready")
	failed := ingest("forward-failed", true, "ready")
	cancelled := ingest("forward-cancelled", true, "ready")
	noEvent := ingest("forward-no-event", true, "ready")
	_ = noEvent
	makeDelivery := func(messageID, state string) string {
		t.Helper()
		eventID, err := ids.New()
		if err != nil {
			t.Fatal(err)
		}
		payload := []byte(`{"type":"mail.received.v1","text":"Private frozen payload"}`)
		hash := sha256.Sum256(payload)
		if _, err := pool.Exec(ctx, `INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload,payload_sha256,state)
			VALUES($1,$2,$3,1,$4,$5,$6)`, eventID, messageID, revisionID, payload, hash[:], state); err != nil {
			t.Fatal(err)
		}
		return eventID
	}
	deliveredEvent := makeDelivery(delivered, "delivered")
	makeDelivery(pending, "pending")
	makeDelivery(sending, "sending")
	makeDelivery(failed, "failed")
	makeDelivery(cancelled, "cancelled")
	attemptID, _ := ids.New()
	if _, err := pool.Exec(ctx, `INSERT INTO delivery_attempts(id,event_id,attempt_no,response_preview)
		VALUES($1,$2,1,'Private HTTP response body')`, attemptID, deliveredEvent); err != nil {
		t.Fatal(err)
	}
	before, err := st.ReconcileLogicalBytes(ctx)
	if err != nil || before <= 0 {
		t.Fatalf("usage reconciliation: bytes=%d error=%v", before, err)
	}
	if result, err := st.ExpireContent(ctx, 100); err != nil || result.Messages != 0 {
		t.Fatalf("NULL retention policy must retain all mail: %+v error=%v", result, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE app_settings SET retention_days=30 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	result, err := st.ExpireContent(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	if result.Messages != 2 || result.BytesCleared <= 0 || result.LogicalBytes != before-result.BytesCleared {
		t.Fatalf("wrong expiration or usage accounting: %+v before=%d", result, before)
	}
	for _, id := range []string{archived, delivered} {
		var rawIsNull, deleted bool
		var envelopeFrom, envelopeRecipient string
		if err := pool.QueryRow(ctx, `SELECT raw IS NULL,content_deleted_at IS NOT NULL,envelope_from,envelope_recipient
			FROM messages WHERE id=$1`, id).Scan(&rawIsNull, &deleted, &envelopeFrom, &envelopeRecipient); err != nil {
			t.Fatal(err)
		}
		if !rawIsNull || !deleted || envelopeFrom != "" || envelopeRecipient != "" {
			t.Fatalf("terminal content or envelope remains for %s", id)
		}
	}
	for _, id := range []string{failedParse, recent, pending, sending, failed, cancelled, noEvent} {
		var rawIsNull, deleted bool
		if err := pool.QueryRow(ctx, `SELECT raw IS NULL,content_deleted_at IS NOT NULL FROM messages WHERE id=$1`, id).Scan(&rawIsNull, &deleted); err != nil {
			t.Fatal(err)
		}
		if rawIsNull || deleted {
			t.Fatalf("nonterminal or recent mail %s was cleared", id)
		}
	}
	var payloadIsNull, previewIsNull bool
	if err := pool.QueryRow(ctx, `SELECT payload IS NULL FROM deliveries WHERE event_id=$1`, deliveredEvent).Scan(&payloadIsNull); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT response_preview IS NULL FROM delivery_attempts WHERE id=$1`, attemptID).Scan(&previewIsNull); err != nil {
		t.Fatal(err)
	}
	if !payloadIsNull || !previewIsNull {
		t.Fatal("expired content remained in payload or failed-response preview")
	}
	var used int64
	if err := pool.QueryRow(ctx, `SELECT logical_bytes FROM app_settings WHERE id=1`).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if used != result.LogicalBytes {
		t.Fatalf("persisted quota usage differs from cleanup result: %d != %d", used, result.LogicalBytes)
	}
	retry, err := st.Ingest(ctx, store.IngestInput{EnvelopeFrom: "sender@example.org", Recipient: "hero@in.example.org", Raw: rawByID[archived]})
	if err != nil || !retry.Duplicate || retry.MessageID != archived {
		t.Fatalf("SMTP retry revived expired content: %+v error=%v", retry, err)
	}
	var revived bool
	if err := pool.QueryRow(ctx, `SELECT raw IS NOT NULL FROM messages WHERE id=$1`, archived).Scan(&revived); err != nil || revived {
		t.Fatalf("expired raw revived after duplicate delivery: %v %v", revived, err)
	}
	secondPass, err := st.ExpireContent(ctx, 100)
	if err != nil || secondPass.Messages != 0 {
		t.Fatalf("expiration was not idempotent: %+v error=%v", secondPass, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE app_settings SET logical_limit_bytes=logical_bytes WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Ingest(ctx, store.IngestInput{EnvelopeFrom: "sender@example.org", Recipient: "hero@in.example.org", Raw: []byte("new synthetic message")}); !errors.Is(err, store.ErrCapacity) {
		t.Fatalf("reconciled capacity did not reject new mail: %v", err)
	}
}
