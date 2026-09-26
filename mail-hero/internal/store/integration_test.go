package store

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/ziyixi/mail-hero/internal/ids"
)

// This test only runs against an explicitly named test database. It creates a
// unique schema and drops only that schema, leaving other schemas untouched.
func TestIngestPostgreSQLTransactionSnapshotCapacityAndTombstone(t *testing.T) {
	url := os.Getenv("MAIL_HERO_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set MAIL_HERO_TEST_DATABASE_URL for PostgreSQL integration test")
	}
	parsed, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.ToLower(parsed.ConnConfig.Database), "test") {
		t.Fatal("MAIL_HERO_TEST_DATABASE_URL must name a test database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	uid, err := ids.New()
	if err != nil {
		t.Fatal(err)
	}
	schema := "mailhero_test_" + strings.ReplaceAll(uid, "-", "")
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := admin.Exec(cleanupCtx, "DROP SCHEMA "+quotedSchema+" CASCADE"); err != nil {
			t.Errorf("remove isolated test schema: %v", err)
		}
	}()
	parsed.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, parsed)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	migration, err := os.ReadFile("../../migrations/00001_initial.sql")
	if err != nil {
		t.Fatal(err)
	}
	up := strings.SplitN(string(migration), "-- +goose Down", 2)[0]
	if _, err := pool.Exec(ctx, up, pgx.QueryExecModeSimpleProtocol); err != nil {
		t.Fatalf("initial migration: %v", err)
	}
	cloudMigration, err := os.ReadFile("../../migrations/00002_cloudflare_ingest.sql")
	if err != nil {
		t.Fatal(err)
	}
	cloudUp := strings.SplitN(string(cloudMigration), "-- +goose Down", 2)[0]
	if _, err := pool.Exec(ctx, cloudUp, pgx.QueryExecModeSimpleProtocol); err != nil {
		t.Fatalf("Cloudflare migration: %v", err)
	}
	s := &Store{pool: pool}
	first := IngestInput{EnvelopeFrom: "Sender@EXAMPLE.ORG", Recipient: "hero@in.example.org", Raw: []byte("Subject: One\r\n\r\nSynthetic one.\r\n")}
	accepted, err := s.Ingest(ctx, first)
	if err != nil || accepted.Duplicate || accepted.ArrivalCount != 1 {
		t.Fatalf("initial ingest: %+v, %v", accepted, err)
	}
	var mode, envelopeFrom, parseState string
	var revision *string
	var raw []byte
	if err := pool.QueryRow(ctx, `SELECT receive_mode, endpoint_revision_id, envelope_from, raw, parse_state
		FROM messages WHERE id = $1`, accepted.MessageID).Scan(&mode, &revision, &envelopeFrom, &raw, &parseState); err != nil {
		t.Fatal(err)
	}
	if mode != "archive" || revision != nil || envelopeFrom != "Sender@example.org" || string(raw) != string(first.Raw) || parseState != "pending" {
		t.Fatalf("uncommitted or wrong snapshot: mode=%s revision=%v from=%s state=%s raw=%q", mode, revision, envelopeFrom, parseState, raw)
	}

	endpointID, _ := ids.New()
	revisionID, _ := ids.New()
	if _, err := pool.Exec(ctx, `INSERT INTO webhook_endpoints (id,label) VALUES ($1,'test')`, endpointID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO endpoint_revisions (id,endpoint_id,revision,url,auth_type)
		VALUES ($1,$2,1,'https://example.invalid/hooks','none')`, revisionID, endpointID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE webhook_endpoints SET current_revision_id=$1 WHERE id=$2`, revisionID, endpointID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE app_settings SET mode='forward',current_endpoint_id=$1 WHERE id=1`, endpointID); err != nil {
		t.Fatal(err)
	}
	second := IngestInput{EnvelopeFrom: "Sender@EXAMPLE.ORG", Recipient: "hero@in.example.org", Raw: []byte("Subject: Two\r\n\r\nSynthetic two.\r\n")}
	forwarded, err := s.Ingest(ctx, second)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT receive_mode, endpoint_revision_id FROM messages WHERE id=$1`, forwarded.MessageID).Scan(&mode, &revision); err != nil {
		t.Fatal(err)
	}
	if mode != "forward" || revision == nil || *revision != revisionID {
		t.Fatalf("new message did not freeze the active revision: %s %v", mode, revision)
	}
	duplicate, err := s.Ingest(ctx, first)
	if err != nil || !duplicate.Duplicate || duplicate.MessageID != accepted.MessageID || duplicate.ArrivalCount != 2 {
		t.Fatalf("duplicate retry: %+v, %v", duplicate, err)
	}
	if err := pool.QueryRow(ctx, `SELECT receive_mode FROM messages WHERE id=$1`, accepted.MessageID).Scan(&mode); err != nil || mode != "archive" {
		t.Fatalf("duplicate changed original routing snapshot: %s, %v", mode, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE messages SET raw=NULL,parsed_json=NULL,subject=NULL,from_text=NULL,
		search_text=NULL,content_deleted_at=now() WHERE id=$1`, accepted.MessageID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Ingest(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT raw FROM messages WHERE id=$1`, accepted.MessageID).Scan(&raw); err != nil || raw != nil {
		t.Fatalf("deleted content revived: raw=%q error=%v", raw, err)
	}
	empty, err := s.Ingest(ctx, IngestInput{EnvelopeFrom: "", Recipient: "hero@in.example.org"})
	if err != nil {
		t.Fatalf("complete empty DATA must be saved for parser review: %v", err)
	}
	var rawIsNull bool
	var emptySize int64
	if err := pool.QueryRow(ctx, `SELECT raw IS NULL,size_bytes FROM messages WHERE id=$1`, empty.MessageID).Scan(&rawIsNull, &emptySize); err != nil || rawIsNull || emptySize != 0 {
		t.Fatalf("empty DATA saved as missing content: rawIsNull=%v size=%d error=%v", rawIsNull, emptySize, err)
	}
	var used int64
	if err := pool.QueryRow(ctx, `SELECT logical_bytes FROM app_settings WHERE id=1`).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE app_settings SET logical_limit_bytes=$1 WHERE id=1`, used+int64(len(second.Raw))-1); err != nil {
		t.Fatal(err)
	}
	third := IngestInput{EnvelopeFrom: "Sender@EXAMPLE.ORG", Recipient: "hero@in.example.org", Raw: []byte("Subject: Three\r\n\r\nSynthetic three.\r\n")}
	if _, err := s.Ingest(ctx, third); !errors.Is(err, ErrCapacity) {
		t.Fatalf("expected capacity rejection, got %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM messages`).Scan(&count); err != nil || count != 3 {
		t.Fatalf("rejected message inserted: count=%d error=%v", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM deliveries`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("SMTP performed network-side delivery: count=%d error=%v", count, err)
	}

	// A Cloudflare replay with the same external ID must be acknowledged from
	// the committed receipt without changing the arrival count or routing.
	if _, err := pool.Exec(ctx, `UPDATE app_settings SET logical_limit_bytes=10737418240 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	externalID, err := ids.New()
	if err != nil {
		t.Fatal(err)
	}
	receivedAt := time.Now().UTC().Truncate(time.Millisecond)
	cloudMail := IngestInput{
		EnvelopeFrom: "sender@example.org", Recipient: "hero@in.example.org",
		Raw:    []byte("From: sender@example.org\r\nSubject: Cloud test\r\n\r\nA body.\r\n"),
		Origin: "cloudflare", ExternalID: externalID, ReceivedAt: receivedAt,
	}
	cloudSaved, err := s.Ingest(ctx, cloudMail)
	if err != nil || cloudSaved.Duplicate || cloudSaved.ArrivalCount != 1 {
		t.Fatalf("Cloudflare ingest: %+v, %v", cloudSaved, err)
	}
	cloudReplay, err := s.Ingest(ctx, cloudMail)
	if err != nil || !cloudReplay.Duplicate || cloudReplay.MessageID != cloudSaved.MessageID || cloudReplay.ArrivalCount != 1 {
		t.Fatalf("Cloudflare replay changed receipt: %+v, %v", cloudReplay, err)
	}
	changed := cloudMail
	changed.Raw = []byte("different mail")
	if _, err := s.Ingest(ctx, changed); !errors.Is(err, ErrIngestConflict) {
		t.Fatalf("same external ID accepted changed content: %v", err)
	}
	changed = cloudMail
	changed.ReceivedAt = changed.ReceivedAt.Add(time.Second)
	if _, err := s.Ingest(ctx, changed); !errors.Is(err, ErrIngestConflict) {
		t.Fatalf("same external ID accepted changed metadata: %v", err)
	}
	secondID, err := ids.New()
	if err != nil {
		t.Fatal(err)
	}
	changed = cloudMail
	changed.ExternalID = secondID
	cloudSecond, err := s.Ingest(ctx, changed)
	if err != nil || !cloudSecond.Duplicate || cloudSecond.MessageID != cloudSaved.MessageID || cloudSecond.ArrivalCount != 2 {
		t.Fatalf("same content with new external ID: %+v, %v", cloudSecond, err)
	}
	var cloudOrigin string
	var cloudTime time.Time
	if err := pool.QueryRow(ctx, `SELECT origin,received_at FROM messages WHERE id=$1`, cloudSaved.MessageID).Scan(&cloudOrigin, &cloudTime); err != nil || cloudOrigin != "cloudflare" || !cloudTime.Equal(receivedAt) {
		t.Fatalf("Cloudflare mail not persisted as visible origin: %s %s %v", cloudOrigin, cloudTime, err)
	}
}
