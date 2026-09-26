package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCanonicalReceiveAddress(t *testing.T) {
	got, err := CanonicalReceiveAddress("hero+gmail@IN.Example.ORG")
	if err != nil || got != "hero+gmail@in.example.org" {
		t.Fatalf("got %q, %v", got, err)
	}
	for _, invalid := range []string{"", "Hero@in.example.org", ".hero@in.example.org", "hero..x@in.example.org", "hero@localhost", "hero@bad_domain.org", "A <hero@in.example.org>"} {
		if _, err := CanonicalReceiveAddress(invalid); err == nil {
			t.Errorf("accepted invalid address %q", invalid)
		}
	}
}

func TestDatabaseCredentialMustComeFromFileOutsideLoopbackDevelopment(t *testing.T) {
	t.Setenv("MAIL_HERO_RECEIVE_ADDRESS", "hero@in.example.org")
	t.Setenv("DATABASE_URL", "postgres://not-a-secret@example.invalid/test")
	t.Setenv("MAIL_HERO_DATABASE_URL_FILE", "")
	t.Setenv("MAIL_HERO_ACCESS_ISSUER", "https://access.example.org")
	t.Setenv("MAIL_HERO_ACCESS_AUDIENCE", "audience")
	t.Setenv("MAIL_HERO_ACCESS_OWNER", "owner@example.org")
	t.Setenv("MAIL_HERO_SECRET_KEY_FILE", "/tmp/synthetic-key")
	t.Setenv("MAIL_HERO_MX_HOSTNAME", "mx.in.example.org")
	t.Setenv("MAIL_HERO_SMTP_TLS_CERT_FILE", "/tmp/synthetic-cert")
	t.Setenv("MAIL_HERO_SMTP_TLS_KEY_FILE", "/tmp/synthetic-cert-key")
	t.Setenv("MAIL_HERO_DEV_AUTH_BYPASS", "false")
	if _, err := LoadFromEnv(); err == nil || !strings.Contains(err.Error(), "MAIL_HERO_DATABASE_URL_FILE") {
		t.Fatalf("expected file requirement, got %v", err)
	}
	path := filepath.Join(t.TempDir(), "database-url")
	if err := os.WriteFile(path, []byte("postgres://synthetic@localhost/test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MAIL_HERO_DATABASE_URL_FILE", path)
	got, err := LoadFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if got.DatabaseURL != "postgres://synthetic@localhost/test" || got.DatabaseURLFile != path {
		t.Fatal("database URL was not loaded from the file")
	}
}

func TestDevelopmentBypassRequiresLoopback(t *testing.T) {
	c := Config{
		ReceiveAddress:    "hero@in.example.org",
		DatabaseURL:       "postgres://localhost/test",
		SMTPListenAddress: "127.0.0.1:2525",
		HTTPListenAddress: "0.0.0.0:8080",
		SecretKeyFile:     "/tmp/synthetic-key",
		DevAuthBypass:     true,
		AllowInsecureSMTP: true,
		MaxMessageBytes:   DefaultMaxMessageBytes,
	}
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "loopback HTTP") {
		t.Fatalf("public auth bypass accepted: %v", err)
	}
}

func TestCloudflareIngestNeedsTokenButNoSMTPListenerCertificate(t *testing.T) {
	c := Config{
		ReceiveAddress:    "hero@in.example.org",
		IngestTransport:   "cloudflare",
		DatabaseURL:       "postgres://localhost/test",
		SMTPListenAddress: "127.0.0.1:2525",
		HTTPListenAddress: "127.0.0.1:8080",
		SecretKeyFile:     "/tmp/synthetic-key",
		DevAuthBypass:     true,
		MaxMessageBytes:   DefaultMaxMessageBytes,
	}
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "MAIL_HERO_INGEST_TOKEN_FILE") {
		t.Fatalf("missing Cloudflare token accepted: %v", err)
	}
	c.IngestTokenFile = "/tmp/synthetic-ingest-token"
	if err := c.Validate(); err != nil {
		t.Fatalf("Cloudflare ingest should not require SMTP MX/certificate settings: %v", err)
	}
}
