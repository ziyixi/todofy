package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/ziyixi/mail-hero/internal/config"
	"github.com/ziyixi/mail-hero/internal/ids"
)

// The synthetic test database is isolated further by a per-test schema. It
// exercises the HTTP acknowledgement and the PostgreSQL receipt together.
func TestCloudflareIngestHTTPAcknowledgesOnlyCommittedMail(t *testing.T) {
	databaseURL := os.Getenv("MAIL_HERO_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set MAIL_HERO_TEST_DATABASE_URL for PostgreSQL integration test")
	}
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.ToLower(poolConfig.ConnConfig.Database), "test") {
		t.Fatal("MAIL_HERO_TEST_DATABASE_URL must name a test database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	schemaID, err := ids.New()
	if err != nil {
		t.Fatal(err)
	}
	schema := "mailhero_test_" + strings.ReplaceAll(schemaID, "-", "")
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
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	for _, name := range []string{"00001_initial.sql", "00002_cloudflare_ingest.sql"} {
		migration, err := os.ReadFile(filepath.Join("..", "..", "migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		up := strings.SplitN(string(migration), "-- +goose Down", 2)[0]
		if _, err := pool.Exec(ctx, up, pgx.QueryExecModeSimpleProtocol); err != nil {
			t.Fatalf("migration %s: %v", name, err)
		}
	}
	token := strings.Repeat("b", 64)
	tokenFile := filepath.Join(t.TempDir(), "ingest-token")
	if err := os.WriteFile(tokenFile, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	server, err := New(config.Config{
		ReceiveAddress: "hero@in.example.org", IngestTransport: "cloudflare", IngestTokenFile: tokenFile,
		DevAuthBypass: true, MaxMessageBytes: config.DefaultMaxMessageBytes,
	}, pool, nil, []byte(strings.Repeat("k", 32)))
	if err != nil {
		t.Fatal(err)
	}
	id, err := ids.New()
	if err != nil {
		t.Fatal(err)
	}
	receivedAt := time.Now().UTC().Truncate(time.Millisecond)
	raw := []byte("From: sender@example.org\r\nSubject: Synthetic\r\n\r\nBody.\r\n")
	requestWithSize := func(ingestID string, body []byte, credential string, declaredSize int) *httptest.ResponseRecorder {
		t.Helper()
		metadata, err := json.Marshal(map[string]any{
			"from": "sender@example.org", "to": "hero@in.example.org",
			"received_at": receivedAt, "size_bytes": declaredSize,
		})
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodPost, "https://mail.example.org/api/v1/ingest/email", bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+credential)
		r.Header.Set("Content-Type", "message/rfc822")
		r.Header.Set("X-Mail-Hero-Ingest-Id", ingestID)
		r.Header.Set("X-Mail-Hero-Metadata", base64.RawURLEncoding.EncodeToString(metadata))
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, r)
		return response
	}
	request := func(ingestID string, body []byte, credential string) *httptest.ResponseRecorder {
		return requestWithSize(ingestID, body, credential, len(body))
	}
	first := request(id, raw, token)
	if first.Code != http.StatusNoContent || first.Header().Get("X-Mail-Hero-Ingest-Id") != id || first.Body.Len() != 0 {
		t.Fatalf("first ingest acknowledgement: status=%d header=%q body=%q", first.Code, first.Header().Get("X-Mail-Hero-Ingest-Id"), first.Body.String())
	}
	for _, replay := range []*httptest.ResponseRecorder{request(id, raw, token), request(id, raw, token)} {
		if replay.Code != http.StatusNoContent || replay.Header().Get("X-Mail-Hero-Ingest-Id") != id {
			t.Fatalf("replay acknowledgement: status=%d header=%q", replay.Code, replay.Header().Get("X-Mail-Hero-Ingest-Id"))
		}
	}
	changed := bytes.Clone(raw)
	changed[len(changed)-3] ^= 1
	if conflict := request(id, changed, token); conflict.Code != http.StatusConflict {
		t.Fatalf("changed body with reused ingest ID: %d", conflict.Code)
	}
	if truncated := requestWithSize(id, raw[:len(raw)-1], token, len(raw)); truncated.Code != http.StatusServiceUnavailable || truncated.Header().Get("X-Mail-Hero-Ingest-Id") != "" {
		t.Fatalf("short body was acknowledged: status=%d header=%q", truncated.Code, truncated.Header().Get("X-Mail-Hero-Ingest-Id"))
	}
	if unauthorized := request(id, raw, "incorrect"); unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("incorrect machine token: %d", unauthorized.Code)
	}
	var count, arrivalCount int
	var storedRaw []byte
	if err := pool.QueryRow(ctx, `SELECT count(*),max(arrival_count) FROM messages WHERE origin='cloudflare'`).Scan(&count, &arrivalCount); err != nil {
		t.Fatal(err)
	}
	if count != 1 || arrivalCount != 1 {
		t.Fatalf("same ingest ID persisted %d messages and %d arrivals", count, arrivalCount)
	}
	if err := pool.QueryRow(ctx, `SELECT raw FROM messages WHERE origin='cloudflare'`).Scan(&storedRaw); err != nil || !bytes.Equal(storedRaw, raw) {
		t.Fatalf("committed raw MIME differs: %q, %v", storedRaw, err)
	}
	newID, err := ids.New()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE app_settings SET logical_limit_bytes=logical_bytes WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	full := request(newID, []byte("Subject: Another\r\n\r\nNo capacity.\r\n"), token)
	if full.Code != http.StatusServiceUnavailable || full.Header().Get("X-Mail-Hero-Ingest-Id") != "" {
		t.Fatalf("uncommitted mail was acknowledged: status=%d header=%q", full.Code, full.Header().Get("X-Mail-Hero-Ingest-Id"))
	}
	var receipts int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM ingest_receipts WHERE external_id=$1`, newID).Scan(&receipts); err != nil || receipts != 0 {
		t.Fatalf("uncommitted mail gained a receipt: count=%d err=%v", receipts, err)
	}
	server.Cfg.MaxMessageBytes = 5
	oversize := request(newID, raw, token)
	if oversize.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize raw MIME accepted: %d", oversize.Code)
	}
}
