package store

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/ziyixi/mail-hero/internal/config"
	"github.com/ziyixi/mail-hero/internal/ids"
)

var (
	ErrCapacity          = errors.New("mail content capacity reached")
	ErrInvalidMessage    = errors.New("invalid mail message")
	ErrInvalidRecipient  = errors.New("recipient does not match the configured address")
	ErrTargetUnavailable = errors.New("current webhook endpoint has no usable revision")
	ErrIngestConflict    = errors.New("ingest ID was already used for different mail")
)

var externalIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type Store struct {
	pool *pgxpool.Pool
}

// IngestInput is the complete SMTP DATA and the actual SMTP envelope. Raw must
// not include any Mail Hero generated headers. The caller must check EOF before
// calling Ingest; no partial message is allowed to reach this method.
type IngestInput struct {
	EnvelopeFrom string
	Recipient    string
	Raw          []byte
	Origin       string
	ExternalID   string
	ReceivedAt   time.Time
}

type IngestResult struct {
	MessageID    string
	Duplicate    bool
	ArrivalCount int
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	if strings.TrimSpace(databaseURL) == "" {
		return nil, errors.New("database URL is empty")
	}
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, errors.New("invalid PostgreSQL connection settings")
	}
	poolConfig.MaxConns = 10
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("create PostgreSQL pool: %w", err)
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, safeDBError("connect to PostgreSQL", err)
	}
	if err = checkDurability(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// FromPool lets the HTTP ingest boundary share the already-open, locked pool.
func FromPool(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Close() { s.pool.Close() }

// Ingest atomically deduplicates a complete message, freezes current routing,
// accounts for the raw bytes and saves the message. A successful return means
// PostgreSQL committed it; SMTP may then issue its final 250 reply.
func (s *Store) Ingest(ctx context.Context, input IngestInput) (IngestResult, error) {
	origin := input.Origin
	if origin == "" {
		origin = "smtp"
	}
	if origin != "smtp" && origin != "cloudflare" {
		return IngestResult{}, ErrInvalidMessage
	}
	if origin == "cloudflare" {
		if !externalIDPattern.MatchString(input.ExternalID) || input.ReceivedAt.IsZero() || input.ReceivedAt.After(time.Now().Add(5*time.Minute)) {
			return IngestResult{}, ErrInvalidMessage
		}
	} else if input.ExternalID != "" {
		return IngestResult{}, ErrInvalidMessage
	}
	if int64(len(input.Raw)) > config.DefaultMaxMessageBytes {
		return IngestResult{}, ErrInvalidMessage
	}
	if input.Raw == nil {
		// A complete but empty DATA is still a locally delivered message. It
		// needs a non-NULL bytea so the parser can mark it failed for review.
		input.Raw = make([]byte, 0)
	}
	recipient, err := config.CanonicalReceiveAddress(input.Recipient)
	if err != nil || recipient != input.Recipient {
		return IngestResult{}, ErrInvalidRecipient
	}
	from, err := normalizeEnvelopeFrom(input.EnvelopeFrom)
	if err != nil {
		return IngestResult{}, fmt.Errorf("envelope sender: %w", err)
	}
	rawHash := sha256.Sum256(input.Raw)
	key := IngestKey(rawHash, from, recipient)

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return IngestResult{}, safeDBError("start mail transaction", err)
	}
	defer tx.Rollback(ctx)
	if origin == "cloudflare" {
		// Serialize attempts with the same external ID even when their raw bytes
		// differ. A collision only serializes unrelated mail; it cannot merge it.
		idHash := sha256.Sum256([]byte("cloudflare:" + input.ExternalID))
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(binary.BigEndian.Uint64(idHash[:8]))); err != nil {
			return IngestResult{}, safeDBError("lock external mail ID", err)
		}
		if prior, found, err := findExternalReceipt(ctx, tx, input.ExternalID, key, input.ReceivedAt); err != nil {
			return IngestResult{}, err
		} else if found {
			if err := tx.Commit(ctx); err != nil {
				return IngestResult{}, safeDBError("commit duplicate external ID", err)
			}
			return prior, nil
		}
	}
	if duplicate, found, err := recordDuplicate(ctx, tx, key); err != nil {
		return IngestResult{}, err
	} else if found {
		if origin == "cloudflare" {
			if err := saveExternalReceipt(ctx, tx, input.ExternalID, duplicate.MessageID, key, input.ReceivedAt); err != nil {
				return IngestResult{}, err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return IngestResult{}, safeDBError("commit duplicate arrival", err)
		}
		return duplicate, nil
	}

	// Only new messages lock settings. Existing messages are locked first and
	// updated without taking the settings lock, matching parser and deletion
	// operations' message-before-settings order. The second duplicate check
	// closes the race with an ingest that committed while this one waited.
	var mode string
	var currentEndpointID *string
	var logicalBytes, logicalLimit int64
	if err := tx.QueryRow(ctx, `SELECT mode, current_endpoint_id, logical_bytes, logical_limit_bytes
		FROM app_settings WHERE id = 1 FOR UPDATE`).Scan(&mode, &currentEndpointID, &logicalBytes, &logicalLimit); err != nil {
		return IngestResult{}, safeDBError("read receiving settings", err)
	}

	if duplicate, found, err := recordDuplicate(ctx, tx, key); err != nil {
		return IngestResult{}, err
	} else if found {
		if origin == "cloudflare" {
			if err := saveExternalReceipt(ctx, tx, input.ExternalID, duplicate.MessageID, key, input.ReceivedAt); err != nil {
				return IngestResult{}, err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return IngestResult{}, safeDBError("commit duplicate arrival", err)
		}
		return duplicate, nil
	}
	if logicalBytes > logicalLimit-int64(len(input.Raw)) {
		return IngestResult{}, ErrCapacity
	}

	var revisionID *string
	if mode == "forward" {
		if currentEndpointID == nil {
			return IngestResult{}, ErrTargetUnavailable
		}
		var revision string
		err := tx.QueryRow(ctx, `SELECT current_revision_id FROM webhook_endpoints
			WHERE id = $1 AND archived_at IS NULL FOR SHARE`, *currentEndpointID).Scan(&revision)
		if err != nil || revision == "" {
			return IngestResult{}, ErrTargetUnavailable
		}
		revisionID = &revision
	}
	messageID, err := ids.New()
	if err != nil {
		return IngestResult{}, fmt.Errorf("generate message ID: %w", err)
	}
	receivedAt := input.ReceivedAt
	if receivedAt.IsZero() {
		receivedAt = time.Now().UTC()
	}
	_, err = tx.Exec(ctx, `INSERT INTO messages
		(id, ingest_key, envelope_from, envelope_recipient, raw, raw_sha256, size_bytes,
		 receive_mode, endpoint_revision_id, parse_state, origin, received_at, last_received_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$11)`,
		messageID, key[:], from, recipient, input.Raw, rawHash[:], len(input.Raw), mode, revisionID, origin, receivedAt)
	if err != nil {
		return IngestResult{}, safeDBError("save raw message", err)
	}
	if origin == "cloudflare" {
		if err := saveExternalReceipt(ctx, tx, input.ExternalID, messageID, key, input.ReceivedAt); err != nil {
			return IngestResult{}, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE app_settings SET logical_bytes = logical_bytes + $1,
		updated_at = now() WHERE id = 1`, len(input.Raw)); err != nil {
		return IngestResult{}, safeDBError("account for raw message", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return IngestResult{}, safeDBError("commit received message", err)
	}
	return IngestResult{MessageID: messageID, ArrivalCount: 1}, nil
}

func findExternalReceipt(ctx context.Context, tx pgx.Tx, externalID string, key [32]byte, receivedAt time.Time) (IngestResult, bool, error) {
	var id string
	var savedKey []byte
	var savedReceivedAt time.Time
	var arrivalCount int
	err := tx.QueryRow(ctx, `SELECT r.message_id::text, r.ingest_key, r.received_at, m.arrival_count
		FROM ingest_receipts r JOIN messages m ON m.id=r.message_id
		WHERE r.source='cloudflare' AND r.external_id=$1`, externalID).Scan(&id, &savedKey, &savedReceivedAt, &arrivalCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return IngestResult{}, false, nil
	}
	if err != nil {
		return IngestResult{}, false, safeDBError("check external mail ID", err)
	}
	if string(savedKey) != string(key[:]) || !savedReceivedAt.Equal(receivedAt) {
		return IngestResult{}, false, ErrIngestConflict
	}
	return IngestResult{MessageID: id, Duplicate: true, ArrivalCount: arrivalCount}, true, nil
}

func saveExternalReceipt(ctx context.Context, tx pgx.Tx, externalID, messageID string, key [32]byte, receivedAt time.Time) error {
	if _, err := tx.Exec(ctx, `INSERT INTO ingest_receipts(source,external_id,message_id,ingest_key,received_at)
		VALUES ('cloudflare',$1,$2,$3,$4)`, externalID, messageID, key[:], receivedAt); err != nil {
		return safeDBError("record external mail ID", err)
	}
	return nil
}

func recordDuplicate(ctx context.Context, tx pgx.Tx, key [32]byte) (IngestResult, bool, error) {
	var id string
	var arrivalCount int
	err := tx.QueryRow(ctx, `SELECT id, arrival_count FROM messages WHERE ingest_key = $1 FOR UPDATE`, key[:]).Scan(&id, &arrivalCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return IngestResult{}, false, nil
	}
	if err != nil {
		return IngestResult{}, false, safeDBError("check duplicate arrival", err)
	}
	if err := tx.QueryRow(ctx, `UPDATE messages SET arrival_count = arrival_count + 1,
		last_received_at = now() WHERE id = $1 RETURNING arrival_count`, id).Scan(&arrivalCount); err != nil {
		return IngestResult{}, false, safeDBError("record duplicate arrival", err)
	}
	return IngestResult{MessageID: id, Duplicate: true, ArrivalCount: arrivalCount}, true, nil
}

// IngestKey is stable across SMTP retries and intentionally excludes dates,
// Message-ID and local processing metadata.
func IngestKey(rawHash [32]byte, normalizedFrom, canonicalRecipient string) [32]byte {
	h := sha256.New()
	h.Write(rawHash[:])
	h.Write([]byte{0})
	h.Write([]byte(normalizedFrom))
	h.Write([]byte{0})
	h.Write([]byte(canonicalRecipient))
	var key [32]byte
	copy(key[:], h.Sum(nil))
	return key
}

func normalizeEnvelopeFrom(from string) (string, error) {
	if from == "" {
		return "", nil // RFC 5321 null reverse-path, commonly used for bounces.
	}
	if strings.ContainsAny(from, "\r\n\x00<>") || strings.Count(from, "@") != 1 {
		return "", ErrInvalidMessage
	}
	at := strings.LastIndexByte(from, '@')
	if at == 0 || at == len(from)-1 {
		return "", ErrInvalidMessage
	}
	return from[:at+1] + strings.ToLower(from[at+1:]), nil
}

func checkDurability(ctx context.Context, pool *pgxpool.Pool) error {
	var fsync, synchronousCommit, fullPageWrites string
	if err := pool.QueryRow(ctx, `SELECT current_setting('fsync'),
		current_setting('synchronous_commit'), current_setting('full_page_writes')`).Scan(&fsync, &synchronousCommit, &fullPageWrites); err != nil {
		return safeDBError("check PostgreSQL durability settings", err)
	}
	if fsync != "on" || synchronousCommit != "on" || fullPageWrites != "on" {
		return fmt.Errorf("PostgreSQL durability settings require fsync=on, synchronous_commit=on and full_page_writes=on")
	}
	return nil
}

// PostgreSQL constraint errors can include a failed row in Detail. A failed
// messages insert would then reveal raw mail if wrapped and logged. Keep only
// the SQLSTATE and operation name at the storage boundary.
func safeDBError(operation string, err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s: %w", operation, err)
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return fmt.Errorf("%s: PostgreSQL SQLSTATE %s", operation, pgErr.Code)
	}
	return fmt.Errorf("%s: PostgreSQL unavailable", operation)
}
