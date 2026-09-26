package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ziyixi/mail-hero/internal/config"
	"github.com/ziyixi/mail-hero/internal/delivery"
)

func TestCredentialScopeCannotCrossOrigin(t *testing.T) {
	if !mayReuseCredential("https://hook.example.org/a", "https://hook.example.org/b", "bearer", "bearer") {
		t.Fatal("same origin and auth type should reuse the credential")
	}
	for _, target := range []string{"https://other.example.org/a", "http://hook.example.org/a", "https://hook.example.org:8443/a"} {
		if mayReuseCredential("https://hook.example.org/a", target, "bearer", "bearer") {
			t.Fatalf("credential would leak to %s", target)
		}
	}
	if mayReuseCredential("https://hook.example.org/a", "https://hook.example.org/a", "bearer", "basic") {
		t.Fatal("credential must not cross authentication schemes")
	}
}

func TestCloudflareIngestRequiresSeparateMachineToken(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	token := strings.Repeat("a", 64)
	tokenFile := filepath.Join(t.TempDir(), "ingest-token")
	if err := os.WriteFile(tokenFile, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	server, err := New(config.Config{
		IngestTransport: "cloudflare", IngestTokenFile: tokenFile,
		AccessIssuer: "https://team.cloudflareaccess.com", AccessAudience: "audience", AccessOwner: "owner@example.org",
	}, nil, &delivery.Manager{Key: key}, key)
	if err != nil {
		t.Fatal(err)
	}
	url := "https://mail.example.org/api/v1/ingest/email"
	for _, auth := range []string{"", "Bearer wrong", "Basic " + token} {
		req := httptest.NewRequest(http.MethodPost, url, strings.NewReader("synthetic mail"))
		req.Header.Set("Authorization", auth)
		req.Header.Set("Cf-Access-Jwt-Assertion", "forged")
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, req)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("ingest accepted owner/incorrect credential %q: %d", auth, response.Code)
		}
	}
	req := httptest.NewRequest(http.MethodPost, url, strings.NewReader("synthetic mail"))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Mail-Hero-Ingest-Id", "invalid-id")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, req)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("machine token did not reach input validation without owner JWT/CSRF: %d", response.Code)
	}
	legacy, err := New(config.Config{DevAuthBypass: true}, nil, &delivery.Manager{Key: key}, key)
	if err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPost, url, strings.NewReader("synthetic mail"))
	req.Header.Set("Authorization", "Bearer "+token)
	response = httptest.NewRecorder()
	legacy.Handler().ServeHTTP(response, req)
	if response.Code != http.StatusNotFound {
		t.Fatalf("machine ingest exposed in SMTP mode: %d", response.Code)
	}
}

func TestAccessHeaderMustBeVerifiedAndMutationNeedsCSRF(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	production, err := New(config.Config{AccessIssuer: "https://team.cloudflareaccess.com", AccessAudience: "audience", AccessOwner: "owner@example.org"}, nil, &delivery.Manager{Key: key}, key)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "https://mail.example.org/api/v1/settings", nil)
	req.Header.Set("Cf-Access-Jwt-Assertion", "forged")
	response := httptest.NewRecorder()
	production.Handler().ServeHTTP(response, req)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("forged Access header status=%d", response.Code)
	}
	dev, err := New(config.Config{DevAuthBypass: true}, nil, &delivery.Manager{Key: key}, key)
	if err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPatch, "http://localhost/api/v1/settings", nil)
	response = httptest.NewRecorder()
	dev.Handler().ServeHTTP(response, req)
	if response.Code != http.StatusForbidden {
		t.Fatalf("mutation without CSRF status=%d", response.Code)
	}
}

func TestRetentionConfirmationBindsOwnerVersionDaysAndTime(t *testing.T) {
	now := time.Now().UTC()
	s := &Server{Delivery: &delivery.Manager{Key: []byte("0123456789abcdef0123456789abcdef")}}
	token := s.retentionToken("owner", 7, 30, now)
	if !s.validRetentionToken(token, "owner", 7, 30, now) {
		t.Fatal("valid confirmation was rejected")
	}
	for _, mismatch := range []struct {
		owner   string
		version int64
		days    int
		now     time.Time
	}{
		{"other", 7, 30, now},
		{"owner", 8, 30, now},
		{"owner", 7, 7, now},
		{"owner", 7, 30, now.Add(11 * time.Minute)},
	} {
		if s.validRetentionToken(token, mismatch.owner, mismatch.version, mismatch.days, mismatch.now) {
			t.Fatalf("token accepted altered confirmation: %+v", mismatch)
		}
	}
}
