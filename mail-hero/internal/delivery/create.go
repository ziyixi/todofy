package delivery

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/ziyixi/mail-hero/internal/ids"
	"github.com/ziyixi/mail-hero/internal/mailparse"
)

var (
	ErrConflict = errors.New("conflicting operation")
	ErrNotReady = errors.New("message is not ready for delivery")
	ErrGone     = errors.New("message content has been deleted")
	ErrExpired  = errors.New("delivery replay window has expired")
)

type Manager struct {
	Pool                   *pgxpool.Pool
	Key                    []byte
	ReceiveAddress         string
	ForcePaused            bool
	AllowedInternalTargets []string
}

func (m *Manager) ActionHash(parts ...string) []byte {
	h := hmac.New(sha256.New, m.Key)
	for _, part := range parts {
		h.Write([]byte(part))
		h.Write([]byte{0})
	}
	return h.Sum(nil)
}

// reserveAction creates the action idempotency record in the same transaction as
// its effect. A repeated request returns the existing result, including after a
// lost HTTP response. The fingerprint never stores a password or bearer token.
func (m *Manager) ReserveAction(ctx context.Context, tx pgx.Tx, owner, actionID, operation, resource string, hash []byte) (string, error) {
	if actionID == "" {
		return "", errors.New("action_request_id required")
	}
	id, err := ids.New()
	if err != nil {
		return "", err
	}
	var inserted string
	err = tx.QueryRow(ctx, `INSERT INTO ui_actions(id,owner,action_request_id,operation,resource_id,request_hash)
 VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner,action_request_id) DO NOTHING RETURNING id::text`, id, owner, actionID, operation, resource, hash).Scan(&inserted)
	if err == nil {
		return "", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	var oldOperation, oldResource, oldResult string
	var oldHash []byte
	err = tx.QueryRow(ctx, `SELECT operation,COALESCE(resource_id,''),request_hash,COALESCE(result_ref,'') FROM ui_actions WHERE owner=$1 AND action_request_id=$2`, owner, actionID).Scan(&oldOperation, &oldResource, &oldHash, &oldResult)
	if err != nil {
		return "", err
	}
	if oldOperation != operation || oldResource != resource || !hmac.Equal(oldHash, hash) {
		return "", ErrConflict
	}
	return oldResult, nil
}

func FinishAction(ctx context.Context, tx pgx.Tx, owner, actionID, ref string, status int) error {
	if actionID == "" {
		return nil
	}
	_, err := tx.Exec(ctx, `UPDATE ui_actions SET result_ref=$3,http_status=$4 WHERE owner=$1 AND action_request_id=$2`, owner, actionID, ref, status)
	return err
}

// CreateAutomatic runs in the same transaction that stores a successful parse.
// It follows the target revision captured during SMTP commit, not current UI settings.
func (m *Manager) CreateAutomatic(ctx context.Context, tx pgx.Tx, messageID string, parsed mailparse.Message) (string, error) {
	var mode string
	var revisionID *string
	var received time.Time
	var deleted *time.Time
	err := tx.QueryRow(ctx, `SELECT receive_mode,endpoint_revision_id::text,received_at,content_deleted_at FROM messages WHERE id=$1 FOR UPDATE`, messageID).Scan(&mode, &revisionID, &received, &deleted)
	if err != nil {
		return "", err
	}
	if mode != "forward" || revisionID == nil || deleted != nil {
		return "", nil
	}
	eventID, err := ids.New()
	if err != nil {
		return "", err
	}
	raw, sum, payloadErr := BuildPayload(eventID, messageID, received, parsed, m.ReceiveAddress)
	state := "pending"
	lastError := ""
	if payloadErr != nil {
		state = "failed"
		lastError = "invalid_payload"
		raw = nil
		sum = sha256.Sum256(nil)
	}
	tag, err := tx.Exec(ctx, `INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload,payload_sha256,state,retry_mode,last_error)
 VALUES($1,$2,$3,1,$4,$5,$6,'auto',NULLIF($7,'')) ON CONFLICT(message_id,generation) DO NOTHING`, eventID, messageID, *revisionID, raw, sum[:], state, lastError)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 1 && len(raw) > 0 {
		_, err = tx.Exec(ctx, `UPDATE app_settings SET logical_bytes=logical_bytes+$1 WHERE id=1`, len(raw))
	}
	return eventID, err
}

// CreateManual creates either the first event for an archived message or a new
// generation explicitly linked to an earlier event. The caller supplies a
// stable UUID actionID for request retries and a selected endpoint.
func (m *Manager) CreateManual(ctx context.Context, owner, actionID, messageID, endpointID, replayOf string, expectedVersion int64) (string, error) {
	tx, err := m.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	operation := "send"
	if replayOf != "" {
		operation = "replay"
	}
	hash := m.ActionHash(operation, messageID, endpointID, replayOf, fmt.Sprint(expectedVersion))
	existing, err := m.ReserveAction(ctx, tx, owner, actionID, operation, messageID, hash)
	if err != nil {
		return "", err
	}
	if existing != "" {
		return existing, tx.Commit(ctx)
	}
	var parsedJSON []byte
	var received time.Time
	var deleted *time.Time
	var state string
	var version int64
	err = tx.QueryRow(ctx, `SELECT parsed_json,received_at,content_deleted_at,parse_state,version FROM messages WHERE id=$1 FOR UPDATE`, messageID).Scan(&parsedJSON, &received, &deleted, &state, &version)
	if err != nil {
		return "", err
	}
	if deleted != nil {
		return "", ErrGone
	}
	if state != "ready" || len(parsedJSON) == 0 {
		return "", ErrNotReady
	}
	if expectedVersion > 0 && version != expectedVersion {
		return "", ErrConflict
	}
	var parsed mailparse.Message
	if err = json.Unmarshal(parsedJSON, &parsed); err != nil {
		return "", err
	}
	var generation int
	err = tx.QueryRow(ctx, `SELECT COALESCE(MAX(generation),0)+1 FROM deliveries WHERE message_id=$1`, messageID).Scan(&generation)
	if err != nil {
		return "", err
	}
	if replayOf == "" && generation != 1 {
		return "", ErrConflict
	}
	if replayOf != "" {
		var source string
		err = tx.QueryRow(ctx, `SELECT event_id::text FROM deliveries WHERE event_id=$1 AND message_id=$2`, replayOf, messageID).Scan(&source)
		if err != nil {
			return "", err
		}
	}
	var revisionID string
	err = tx.QueryRow(ctx, `SELECT current_revision_id::text FROM webhook_endpoints WHERE id=$1 AND archived_at IS NULL`, endpointID).Scan(&revisionID)
	if err != nil {
		return "", err
	}
	eventID, err := ids.New()
	if err != nil {
		return "", err
	}
	payload, sum, err := BuildPayload(eventID, messageID, received, parsed, m.ReceiveAddress)
	if err != nil {
		return "", err
	}
	var replayPtr *string
	if replayOf != "" {
		replayPtr = &replayOf
	}
	_, err = tx.Exec(ctx, `INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,replay_of_event_id,action_request_id,payload,payload_sha256,state,retry_mode)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending','auto')`, eventID, messageID, revisionID, generation, replayPtr, actionID, payload, sum[:])
	if err != nil {
		return "", fmt.Errorf("create delivery: %w", err)
	}
	if _, err = tx.Exec(ctx, `UPDATE app_settings SET logical_bytes=logical_bytes+$1 WHERE id=1`, len(payload)); err != nil {
		return "", err
	}
	if err = FinishAction(ctx, tx, owner, actionID, eventID, 201); err != nil {
		return "", err
	}
	return eventID, tx.Commit(ctx)
}

func (m *Manager) Retry(ctx context.Context, owner, actionID, eventID string) error {
	tx, err := m.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	hash := m.ActionHash("retry", eventID)
	result, err := m.ReserveAction(ctx, tx, owner, actionID, "retry", eventID, hash)
	if err != nil {
		return err
	}
	if result != "" {
		return tx.Commit(ctx)
	}
	tag, err := tx.Exec(ctx, `UPDATE deliveries SET state='pending',retry_mode='once',next_attempt_at=now(),last_error=NULL
 WHERE event_id=$1 AND state IN ('failed','retry_wait') AND payload IS NOT NULL AND now()<created_at+interval '30 days'`, eventID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrConflict
	}
	if err = FinishAction(ctx, tx, owner, actionID, eventID, 202); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (m *Manager) Cancel(ctx context.Context, owner, actionID, eventID string) error {
	tx, err := m.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	hash := m.ActionHash("cancel", eventID)
	result, err := m.ReserveAction(ctx, tx, owner, actionID, "cancel", eventID, hash)
	if err != nil {
		return err
	}
	if result != "" {
		return tx.Commit(ctx)
	}
	tag, err := tx.Exec(ctx, `UPDATE deliveries SET state='cancelled',last_error='cancelled_by_owner' WHERE event_id=$1 AND state IN ('pending','retry_wait','failed')`, eventID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrConflict
	}
	if err = FinishAction(ctx, tx, owner, actionID, eventID, 200); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
