package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ziyixi/mail-hero/internal/delivery"
	"github.com/ziyixi/mail-hero/internal/ids"
	"github.com/ziyixi/mail-hero/internal/worker"
)

func TestRetryAfterStopsOtherMailToSameEndpoint(t *testing.T) {
	for _, tc := range []struct {
		name   string
		header string
		paused bool
	}{
		{name: "hour_cooldown", header: "3600"},
		{name: "long_pause", header: "90000", paused: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			st := isolatedStore(t, ctx)
			pool := st.Pool()
			var requests atomic.Int32
			consumer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				w.Header().Set("Retry-After", tc.header)
				w.WriteHeader(http.StatusTooManyRequests)
			}))
			defer consumer.Close()
			endpointID, _ := ids.New()
			revisionID, _ := ids.New()
			if _, err := pool.Exec(ctx, `INSERT INTO webhook_endpoints(id,label) VALUES($1,'Synthetic rate-limit consumer')`, endpointID); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type) VALUES($1,$2,1,$3,'none')`, revisionID, endpointID, consumer.URL); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `UPDATE webhook_endpoints SET current_revision_id=$2 WHERE id=$1`, endpointID, revisionID); err != nil {
				t.Fatal(err)
			}
			for n := 0; n < 2; n++ {
				messageID, _ := ids.New()
				eventID, _ := ids.New()
				raw := []byte(fmt.Sprintf("synthetic retry-after mail %d", n))
				hash := sha256.Sum256(raw)
				if _, err := pool.Exec(ctx, `INSERT INTO messages(id,ingest_key,envelope_from,envelope_recipient,raw,raw_sha256,size_bytes,receive_mode,endpoint_revision_id,parse_state,origin)
					VALUES($1,$2,'sender@example.org','hero@in.example.org',$3,$4,$5,'forward',$6,'ready','synthetic_test')`, messageID, hash[:], raw, hash[:], len(raw), revisionID); err != nil {
					t.Fatal(err)
				}
				payload := []byte(fmt.Sprintf(`{"type":"mail.received.v1","event_id":"%s"}`, eventID))
				payloadHash := sha256.Sum256(payload)
				if _, err := pool.Exec(ctx, `INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload,payload_sha256,next_attempt_at)
					VALUES($1,$2,$3,1,$4,$5,now()-($6::int*interval '1 second'))`, eventID, messageID, revisionID, payload, payloadHash[:], 2-n); err != nil {
					t.Fatal(err)
				}
			}
			manager := &delivery.Manager{Pool: pool, Key: bytes.Repeat([]byte{7}, 32), AllowedInternalTargets: []string{strings.TrimPrefix(consumer.URL, "http://")}}
			w := &worker.Worker{Pool: pool, Delivery: manager}
			if worked, err := w.DeliverOne(ctx); err != nil || !worked {
				t.Fatalf("first delivery: worked=%v err=%v", worked, err)
			}
			// Remove only the global rate reservation. The receiving endpoint's
			// explicit cooldown/pause must still prevent the second delivery.
			if _, err := pool.Exec(ctx, `UPDATE app_settings SET next_send_at=now()-interval '1 second' WHERE id=1`); err != nil {
				t.Fatal(err)
			}
			if worked, err := w.DeliverOne(ctx); err != nil || worked {
				t.Fatalf("second delivery ignored endpoint Retry-After: worked=%v err=%v", worked, err)
			}
			if requests.Load() != 1 {
				t.Fatalf("endpoint received %d requests; expected one", requests.Load())
			}
			var paused bool
			var reason *string
			var nextAt time.Time
			if err := pool.QueryRow(ctx, `SELECT paused,paused_reason,next_send_at FROM webhook_endpoints WHERE id=$1`, endpointID).Scan(&paused, &reason, &nextAt); err != nil {
				t.Fatal(err)
			}
			if paused != tc.paused {
				t.Fatalf("paused=%v want=%v", paused, tc.paused)
			}
			if tc.paused {
				if reason == nil || *reason != "retry_after_too_long" {
					t.Fatalf("missing reason for long Retry-After: %v", reason)
				}
			} else if nextAt.Before(time.Now().Add(59 * time.Minute)) {
				t.Fatalf("endpoint cooldown too short: %v", nextAt)
			}
		})
	}
}

func TestRecoveryCancelsDeletedPayloadSendingEvent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	st := isolatedStore(t, ctx)
	pool := st.Pool()
	endpointID, _ := ids.New()
	revisionID, _ := ids.New()
	messageID, _ := ids.New()
	eventID, _ := ids.New()
	attemptID, _ := ids.New()
	if _, err := pool.Exec(ctx, `INSERT INTO webhook_endpoints(id,label) VALUES($1,'Synthetic target')`, endpointID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type) VALUES($1,$2,1,'https://example.org/hooks/mail','none')`, revisionID, endpointID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE webhook_endpoints SET current_revision_id=$2 WHERE id=$1`, endpointID, revisionID); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("deleted synthetic message"))
	if _, err := pool.Exec(ctx, `INSERT INTO messages(id,ingest_key,envelope_from,envelope_recipient,raw_sha256,size_bytes,receive_mode,endpoint_revision_id,parse_state,origin,content_deleted_at)
		VALUES($1,$2,'','',$3,0,'forward',$4,'ready','synthetic_test',now())`, messageID, hash[:], hash[:], revisionID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload,payload_sha256,state,attempt_count)
		VALUES($1,$2,$3,1,NULL,$4,'sending',1)`, eventID, messageID, revisionID, hash[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO delivery_attempts(id,event_id,attempt_no) VALUES($1,$2,1)`, attemptID, eventID); err != nil {
		t.Fatal(err)
	}
	w := &worker.Worker{Pool: pool}
	if err := w.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	var state, lastError, outcome string
	if err := pool.QueryRow(ctx, `SELECT state,last_error FROM deliveries WHERE event_id=$1`, eventID).Scan(&state, &lastError); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT outcome FROM delivery_attempts WHERE id=$1`, attemptID).Scan(&outcome); err != nil {
		t.Fatal(err)
	}
	if state != "cancelled" || lastError != "content_deleted" || outcome != "interrupted" {
		t.Fatalf("recovery left a deleted send active: state=%s error=%s attempt=%s", state, lastError, outcome)
	}
}
