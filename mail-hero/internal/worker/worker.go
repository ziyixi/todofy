package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/ziyixi/mail-hero/internal/delivery"
	"github.com/ziyixi/mail-hero/internal/ids"
	"github.com/ziyixi/mail-hero/internal/mailparse"
	"github.com/ziyixi/mail-hero/internal/store"
)

const parserVersion = "1"

type Worker struct {
	Pool     *pgxpool.Pool
	Delivery *delivery.Manager
	Store    *store.Store
}

func (w *Worker) Recover(ctx context.Context) error {
	tx, err := w.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, q := range []string{
		`UPDATE messages SET parse_state='pending' WHERE parse_state='parsing' AND content_deleted_at IS NULL`,
		`UPDATE deliveries SET state='cancelled',last_error='content_deleted' WHERE state='sending' AND payload IS NULL`,
		`UPDATE deliveries SET state='retry_wait',next_attempt_at=now()+interval '30 seconds',last_error='previous_result_unknown' WHERE state='sending' AND retry_mode='auto' AND payload IS NOT NULL`,
		`UPDATE deliveries SET state='failed',last_error='previous_result_unknown' WHERE state='sending' AND retry_mode='once'`,
		`UPDATE delivery_attempts SET finished_at=now(),outcome='interrupted',error_code='previous_result_unknown' WHERE finished_at IS NULL`,
	} {
		if _, err = tx.Exec(ctx, q); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Run executes bounded parser and delivery work; each step releases SQL locks
// before MIME parsing or network I/O. The main process owns a singleton lock.
func (w *Worker) Run(ctx context.Context) error {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	nextRetention := time.Now()
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		didParse, err := w.ParseOne(ctx)
		if err != nil {
			return fmt.Errorf("parse worker: %w", err)
		}
		didSend, err := w.DeliverOne(ctx)
		if err != nil {
			return fmt.Errorf("delivery worker: %w", err)
		}
		didExpire := false
		if w.Store != nil && !time.Now().Before(nextRetention) {
			result, cleanErr := w.Store.ExpireContent(ctx, 100)
			if cleanErr != nil {
				return fmt.Errorf("retention worker: %w", cleanErr)
			}
			didExpire = result.Messages > 0
			if result.Messages == 100 {
				nextRetention = time.Now().Add(time.Second)
			} else {
				nextRetention = time.Now().Add(time.Minute)
			}
		}
		if didParse || didSend || didExpire {
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (w *Worker) ParseOne(ctx context.Context) (bool, error) {
	tx, err := w.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var id string
	var raw []byte
	var version int64
	err = tx.QueryRow(ctx, `SELECT id::text,raw,version FROM messages WHERE parse_state='pending' AND content_deleted_at IS NULL AND raw IS NOT NULL ORDER BY received_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id, &raw, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, `UPDATE messages SET parse_state='parsing',version=version+1 WHERE id=$1`, id)
	if err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	parseCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	parsed, parseErr := mailparse.ParseContext(parseCtx, raw)
	cancel()
	saveTx, err := w.Pool.Begin(ctx)
	if err != nil {
		return true, err
	}
	defer saveTx.Rollback(ctx)
	if parseErr != nil || parsed.NeedsReview {
		errorCode := "mime_parse_failed"
		if parseErr == nil {
			errorCode = "needs_review"
		}
		_, err = saveTx.Exec(ctx, `UPDATE messages SET parse_state='failed',parse_error=$3,version=version+1 WHERE id=$1 AND version=$2 AND content_deleted_at IS NULL`, id, version+1, errorCode)
		if err != nil {
			return true, err
		}
		return true, saveTx.Commit(ctx)
	}
	encoded, err := json.Marshal(parsed)
	if err != nil {
		return true, err
	}
	var oldDerivedBytes int64
	err = saveTx.QueryRow(ctx, `SELECT COALESCE(octet_length(parsed_json::text),0)+COALESCE(octet_length(subject),0)+COALESCE(octet_length(from_text),0)+COALESCE(octet_length(search_text),0) FROM messages WHERE id=$1 AND version=$2 AND content_deleted_at IS NULL FOR UPDATE`, id, version+1).Scan(&oldDerivedBytes)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, saveTx.Commit(ctx)
	}
	if err != nil {
		return true, err
	}
	search := parsed.Subject + " " + parsed.Text
	if len(search) > 256*1024 {
		search = string([]rune(search)[:min(len([]rune(search)), 128*1024)])
	}
	from := ""
	if len(parsed.From) > 0 {
		from = parsed.From[0].Address
	}
	tag, err := saveTx.Exec(ctx, `UPDATE messages SET parse_state='ready',parsed_json=$3,parser_version=$4,subject=$5,from_text=$6,search_text=$7,has_attachment=$8,parse_error=NULL,version=version+1
 WHERE id=$1 AND version=$2 AND content_deleted_at IS NULL`, id, version+1, encoded, parserVersion, parsed.Subject, from, search, len(parsed.Attachments) > 0)
	if err != nil {
		return true, err
	}
	if tag.RowsAffected() == 0 {
		return true, saveTx.Commit(ctx)
	}
	if _, err = saveTx.Exec(ctx, `UPDATE app_settings SET logical_bytes=GREATEST(0,logical_bytes+octet_length($1::jsonb::text)+octet_length($2::text)+octet_length($3::text)+octet_length($4::text)-$5) WHERE id=1`, encoded, parsed.Subject, from, search, oldDerivedBytes); err != nil {
		return true, err
	}
	if _, err = w.Delivery.CreateAutomatic(ctx, saveTx, id, parsed); err != nil {
		return true, err
	}
	return true, saveTx.Commit(ctx)
}

func backoff(attempt int) time.Duration {
	n := float64(30*time.Second) * math.Pow(2, float64(min(attempt-1, 12)))
	maxDuration := float64(6 * time.Hour)
	if n > maxDuration {
		n = maxDuration
	}
	return time.Duration(n * (0.8 + rand.Float64()*0.4))
}

// DeliverOne handles at most one network attempt. Sending state and attempt row
// commit before HTTP; the exact payload and event ID are reused after uncertainty.
func (w *Worker) DeliverOne(ctx context.Context) (bool, error) {
	if w.Delivery.ForcePaused {
		return false, nil
	}
	_, err := w.Pool.Exec(ctx, `UPDATE deliveries SET state='failed',last_error='retry_window_expired' WHERE state IN ('pending','retry_wait') AND ((retry_mode='auto' AND (now()>=created_at+interval '7 days' OR attempt_count>=48)) OR now()>=created_at+interval '30 days')`)
	if err != nil {
		return false, err
	}
	tx, err := w.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var eventID, revisionID, target, authType, retryMode, credentialKeyID string
	var payload, encrypted []byte
	var timeoutMs, rate, attempt int
	var created time.Time
	err = tx.QueryRow(ctx, `SELECT d.event_id::text,r.id::text,r.url,r.auth_type,COALESCE(r.credential_ciphertext,''::bytea),COALESCE(r.credential_key_id,''),r.timeout_ms,e.rate_per_minute,d.attempt_count,d.retry_mode,d.created_at,d.payload
 FROM deliveries d JOIN endpoint_revisions r ON r.id=d.endpoint_revision_id JOIN webhook_endpoints e ON e.id=r.endpoint_id JOIN app_settings s ON s.id=1
 WHERE d.state IN ('pending','retry_wait') AND d.payload IS NOT NULL AND d.next_attempt_at<=now()
 AND (d.retry_mode='once' OR (d.attempt_count<48 AND d.created_at+interval '7 days'>now()))
 AND d.created_at+interval '30 days'>now() AND NOT s.send_paused AND NOT e.paused AND r.blocked_reason IS NULL
 AND (s.next_send_at IS NULL OR s.next_send_at<=now()) AND (e.next_send_at IS NULL OR e.next_send_at<=now())
 ORDER BY d.next_attempt_at,d.event_id LIMIT 1 FOR UPDATE OF d,e,s SKIP LOCKED`).Scan(&eventID, &revisionID, &target, &authType, &encrypted, &credentialKeyID, &timeoutMs, &rate, &attempt, &retryMode, &created, &payload)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	attempt++
	attemptID, err := ids.New()
	if err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, `UPDATE deliveries SET state='sending',attempt_count=$2 WHERE event_id=$1`, eventID, attempt)
	if err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO delivery_attempts(id,event_id,attempt_no,credential_key_id) VALUES($1,$2,$3,NULLIF($4,''))`, attemptID, eventID, attempt, credentialKeyID)
	if err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, `UPDATE webhook_endpoints SET next_send_at=now()+($2::int*interval '1 second') WHERE id=(SELECT endpoint_id FROM endpoint_revisions WHERE id=$1)`, revisionID, max(1, 60/rate))
	if err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, `UPDATE app_settings SET next_send_at=now()+interval '6 seconds' WHERE id=1`)
	if err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	credential, decErr := delivery.DecryptCredential(w.Delivery.Key, revisionID, target, encrypted)
	status := 0
	preview := ""
	retryHeader := ""
	errorCode := ""
	requestErr := decErr
	if requestErr == nil {
		status, preview, retryHeader, requestErr = delivery.Post(ctx, target, authType, credential, eventID, payload, w.Delivery.AllowedInternalTargets, time.Duration(timeoutMs)*time.Millisecond)
	}
	if requestErr != nil {
		errorCode = "network_error"
		if decErr != nil {
			errorCode = "credential_invalid"
		}
		if errors.Is(requestErr, delivery.ErrTargetBlocked) {
			errorCode = "target_blocked"
		}
	}
	now := time.Now().UTC()
	state := "failed"
	nextAt := now
	lastError := errorCode
	var endpointRetryAt *time.Time
	longRetryAfter := false
	if requestErr == nil {
		switch {
		case status >= 200 && status < 300:
			state = "delivered"
			lastError = ""
		case status == 408 || status == 429 || status >= 500:
			state = "retry_wait"
			lastError = fmt.Sprintf("http_%d", status)
		case status == 401 || status == 403 || status == 404 || status == 405 || status >= 300 && status < 400:
			state = "failed"
			lastError = fmt.Sprintf("http_%d", status)
		default:
			state = "failed"
			lastError = fmt.Sprintf("http_%d", status)
		}
	} else if errorCode == "network_error" {
		state = "retry_wait"
	}
	if state == "retry_wait" {
		nextAt = now.Add(backoff(attempt))
		if retryHeader != "" {
			if provided, parseErr := delivery.RetryAfter(retryHeader, now); parseErr == nil && provided.After(now) {
				endpointRetryAt = &provided
				if provided.After(nextAt) {
					nextAt = provided
				}
				longRetryAfter = provided.After(now.Add(24 * time.Hour))
			}
		}
		if longRetryAfter {
			state = "failed"
			lastError = "retry_after_too_long"
		}
		if retryMode == "once" || attempt >= 48 || now.After(created.Add(7*24*time.Hour)) || nextAt.After(created.Add(7*24*time.Hour)) {
			state = "failed"
			if lastError == "" {
				lastError = "retry_window_expired"
			}
		}
	}
	finished, err := w.Pool.Begin(ctx)
	if err != nil {
		return true, err
	}
	defer finished.Rollback(ctx)
	// Lock in the same order as content deletion: message, delivery, attempt,
	// then settings. A deletion completed during HTTP must not be undone by
	// the result callback or leave a deleted payload queued for retry.
	var deleted bool
	err = finished.QueryRow(ctx, `SELECT m.content_deleted_at IS NOT NULL FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.event_id=$1 FOR UPDATE OF m`, eventID).Scan(&deleted)
	if err != nil {
		return true, err
	}
	attemptOutcome := state
	if deleted {
		preview = ""
		if state != "delivered" {
			state = "cancelled"
			lastError = "content_deleted"
		}
	}
	_, err = finished.Exec(ctx, `UPDATE deliveries SET state=$2,next_attempt_at=$3,delivered_at=CASE WHEN $2='delivered' THEN $4 ELSE delivered_at END,last_error=NULLIF($5,'') WHERE event_id=$1 AND state='sending'`, eventID, state, nextAt, now, lastError)
	if err != nil {
		return true, err
	}
	var oldPreviewBytes int64
	err = finished.QueryRow(ctx, `SELECT COALESCE(octet_length(response_preview),0) FROM delivery_attempts WHERE id=$1 FOR UPDATE`, attemptID).Scan(&oldPreviewBytes)
	if err != nil {
		return true, err
	}
	_, err = finished.Exec(ctx, `UPDATE delivery_attempts SET finished_at=$2,http_status=NULLIF($3,0),duration_ms=GREATEST(0,EXTRACT(EPOCH FROM ($2-started_at))*1000)::int,outcome=$4,error_code=NULLIF($5,''),response_preview=NULLIF($6,'') WHERE id=$1`, attemptID, now, status, attemptOutcome, errorCode, preview)
	if err != nil {
		return true, err
	}
	if longRetryAfter {
		_, err = finished.Exec(ctx, `UPDATE webhook_endpoints SET paused=true,paused_reason='retry_after_too_long',updated_at=now() WHERE id=(SELECT endpoint_id FROM endpoint_revisions WHERE id=$1)`, revisionID)
	} else if endpointRetryAt != nil {
		_, err = finished.Exec(ctx, `UPDATE webhook_endpoints SET next_send_at=GREATEST(COALESCE(next_send_at,'-infinity'::timestamptz),$2) WHERE id=(SELECT endpoint_id FROM endpoint_revisions WHERE id=$1)`, revisionID, *endpointRetryAt)
	}
	if err != nil {
		return true, err
	}
	_, err = finished.Exec(ctx, `UPDATE app_settings SET logical_bytes=GREATEST(0,logical_bytes+octet_length($1::text)-$2) WHERE id=1`, preview, oldPreviewBytes)
	if err != nil {
		return true, err
	}
	if requestErr != nil && (errorCode == "credential_invalid" || errorCode == "target_blocked") || requestErr == nil && (status == 401 || status == 403 || status == 404 || status == 405 || status >= 300 && status < 400) {
		_, err = finished.Exec(ctx, `UPDATE endpoint_revisions SET blocked_reason=$2 WHERE id=$1`, revisionID, lastError)
		if err != nil {
			return true, err
		}
	}
	if err = finished.Commit(ctx); err != nil {
		return true, err
	}
	return true, nil
}
