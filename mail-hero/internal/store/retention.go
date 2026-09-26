package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

const maxExpirationBatch = 100

// ExpiredContentResult describes one bounded cleanup transaction. BytesCleared
// counts message content, frozen webhook bodies and stored response previews.
type ExpiredContentResult struct {
	Messages     int
	BytesCleared int64
	LogicalBytes int64
}

// ExpireContent clears only old, successfully parsed SMTP mail that is safely
// terminal: an archived message without a delivery, or a message whose every
// delivery was acknowledged. Pending, sending, retrying, failed and cancelled
// deliveries remain reviewable. There is no default automatic expiration while
// retention_days is NULL. The ingest key and event IDs remain as tombstones.
func (s *Store) ExpireContent(ctx context.Context, limit int) (ExpiredContentResult, error) {
	if limit < 1 || limit > maxExpirationBatch {
		return ExpiredContentResult{}, fmt.Errorf("expiration batch limit must be between 1 and %d", maxExpirationBatch)
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ExpiredContentResult{}, safeDBError("start expiration transaction", err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT m.id::text
		FROM messages m CROSS JOIN app_settings s
		WHERE s.id = 1 AND s.retention_days IS NOT NULL
		AND m.origin IN ('smtp','cloudflare') AND m.content_deleted_at IS NULL AND m.parse_state = 'ready'
		AND m.received_at < now() - s.retention_days * interval '1 day'
		AND (m.receive_mode = 'archive' OR EXISTS (
			SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.state = 'delivered'))
		AND NOT EXISTS (
			SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.state <> 'delivered')
		ORDER BY m.received_at, m.id LIMIT $1 FOR UPDATE OF m SKIP LOCKED`, limit)
	if err != nil {
		return ExpiredContentResult{}, safeDBError("select expirable mail", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return ExpiredContentResult{}, safeDBError("read expirable mail", err)
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return ExpiredContentResult{}, safeDBError("scan expirable mail", err)
	}
	if len(ids) == 0 {
		return ExpiredContentResult{}, nil
	}

	// Settings are locked after messages to match parser/manual-delete order.
	// A policy edit could have committed while the candidate scan was running,
	// so every candidate is rechecked under the new policy before mutation.
	var retentionDays *int
	if err := tx.QueryRow(ctx, `SELECT retention_days FROM app_settings WHERE id = 1 FOR UPDATE`).Scan(&retentionDays); err != nil {
		return ExpiredContentResult{}, safeDBError("read retention policy", err)
	}
	if retentionDays == nil {
		return ExpiredContentResult{}, nil
	}
	var result ExpiredContentResult
	for _, id := range ids {
		var eligible bool
		var contentBytes int64
		err := tx.QueryRow(ctx, `SELECT
			m.origin IN ('smtp','cloudflare') AND m.content_deleted_at IS NULL AND m.parse_state = 'ready'
			AND m.received_at < now() - $2::int * interval '1 day'
			AND (m.receive_mode = 'archive' OR EXISTS (
				SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.state = 'delivered'))
			AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.state <> 'delivered'),
			COALESCE(octet_length(m.raw), 0)
			+ COALESCE(octet_length(m.parsed_json::text), 0)
			+ COALESCE(octet_length(m.subject), 0)
			+ COALESCE(octet_length(m.from_text), 0)
			+ COALESCE(octet_length(m.search_text), 0)
			+ COALESCE((SELECT sum(octet_length(d.payload)) FROM deliveries d WHERE d.message_id = m.id), 0)
			+ COALESCE((SELECT sum(octet_length(a.response_preview)) FROM delivery_attempts a
				JOIN deliveries d ON d.event_id = a.event_id WHERE d.message_id = m.id), 0)
			FROM messages m WHERE m.id = $1`, id, *retentionDays).Scan(&eligible, &contentBytes)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return ExpiredContentResult{}, safeDBError("recheck expirable mail", err)
		}
		if !eligible {
			continue
		}
		if _, err := tx.Exec(ctx, `UPDATE delivery_attempts SET response_preview = NULL
			WHERE event_id IN (SELECT event_id FROM deliveries WHERE message_id = $1)`, id); err != nil {
			return ExpiredContentResult{}, safeDBError("clear delivery response previews", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE deliveries SET payload = NULL WHERE message_id = $1`, id); err != nil {
			return ExpiredContentResult{}, safeDBError("clear frozen webhook payloads", err)
		}
		tag, err := tx.Exec(ctx, `UPDATE messages SET raw = NULL, parsed_json = NULL, subject = NULL,
			from_text = NULL, search_text = NULL, envelope_from = '', envelope_recipient = '',
			has_attachment = false, parse_error = NULL, content_deleted_at = now(), version = version + 1
			WHERE id = $1 AND content_deleted_at IS NULL`, id)
		if err != nil {
			return ExpiredContentResult{}, safeDBError("clear expired message", err)
		}
		if tag.RowsAffected() != 1 {
			return ExpiredContentResult{}, errors.New("expired message changed during cleanup")
		}
		result.Messages++
		result.BytesCleared += contentBytes
	}
	if result.Messages == 0 {
		return ExpiredContentResult{}, nil
	}
	total, err := sumLogicalContent(ctx, tx)
	if err != nil {
		return ExpiredContentResult{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE app_settings SET logical_bytes = $1, updated_at = now() WHERE id = 1`, total); err != nil {
		return ExpiredContentResult{}, safeDBError("update content usage", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ExpiredContentResult{}, safeDBError("commit expired content", err)
	}
	result.LogicalBytes = total
	return result, nil
}

// ReconcileLogicalBytes computes actual stored mail-content bytes from the
// database. It can be run after a restore or periodically to detect drift in
// incremental accounting before accepting more mail against the logical cap.
func (s *Store) ReconcileLogicalBytes(ctx context.Context) (int64, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, safeDBError("start content usage reconciliation", err)
	}
	defer tx.Rollback(ctx)
	var id int
	if err := tx.QueryRow(ctx, `SELECT id FROM app_settings WHERE id = 1 FOR UPDATE`).Scan(&id); err != nil {
		return 0, safeDBError("lock content usage", err)
	}
	total, err := sumLogicalContent(ctx, tx)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `UPDATE app_settings SET logical_bytes = $1, updated_at = now() WHERE id = 1`, total); err != nil {
		return 0, safeDBError("reconcile content usage", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, safeDBError("commit content usage reconciliation", err)
	}
	return total, nil
}

func sumLogicalContent(ctx context.Context, tx pgx.Tx) (int64, error) {
	var total int64
	err := tx.QueryRow(ctx, `SELECT
		COALESCE((SELECT sum(
			COALESCE(octet_length(raw), 0)
			+ COALESCE(octet_length(parsed_json::text), 0)
			+ COALESCE(octet_length(subject), 0)
			+ COALESCE(octet_length(from_text), 0)
			+ COALESCE(octet_length(search_text), 0)) FROM messages), 0)
		+ COALESCE((SELECT sum(octet_length(payload)) FROM deliveries), 0)
		+ COALESCE((SELECT sum(octet_length(response_preview)) FROM delivery_attempts), 0)`).Scan(&total)
	if err != nil {
		return 0, safeDBError("sum stored mail content", err)
	}
	return total, nil
}
