package integration_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ziyixi/mail-hero/internal/config"
	"github.com/ziyixi/mail-hero/internal/delivery"
	"github.com/ziyixi/mail-hero/internal/httpapi"
	"github.com/ziyixi/mail-hero/internal/store"
)

func TestRetentionPreviewRequiresConfirmedPolicyChange(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	st := isolatedStore(t, ctx)
	result, err := st.Ingest(ctx, store.IngestInput{EnvelopeFrom: "sender@example.org", Recipient: "hero@in.example.org", Raw: []byte("From: sender@example.org\r\nSubject: Synthetic\r\n\r\nBody\r\n")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE messages SET parse_state='ready',received_at=now()-interval '40 days',parsed_json='{"subject":"Synthetic","text":"Body"}'::jsonb,subject='Synthetic' WHERE id=$1`, result.MessageID); err != nil {
		t.Fatal(err)
	}
	key := []byte("0123456789abcdef0123456789abcdef")
	manager := &delivery.Manager{Pool: st.Pool(), Key: key, ReceiveAddress: "hero@in.example.org"}
	api, err := httpapi.New(config.Config{ReceiveAddress: "hero@in.example.org", DevAuthBypass: true}, st.Pool(), manager, key)
	if err != nil {
		t.Fatal(err)
	}
	handler := api.Handler()
	csrf := httptest.NewRecorder()
	handler.ServeHTTP(csrf, httptest.NewRequest(http.MethodGet, "http://localhost/api/v1/csrf", nil))
	if csrf.Code != http.StatusOK || len(csrf.Result().Cookies()) != 1 {
		t.Fatalf("csrf status=%d", csrf.Code)
	}
	var csrfBody struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrf.Body.Bytes(), &csrfBody); err != nil {
		t.Fatal(err)
	}
	preview := httptest.NewRecorder()
	handler.ServeHTTP(preview, httptest.NewRequest(http.MethodGet, "http://localhost/api/v1/settings/retention-preview?days=30", nil))
	if preview.Code != http.StatusOK {
		t.Fatalf("preview status=%d body=%s", preview.Code, preview.Body.String())
	}
	var proposal struct {
		Version    int64  `json:"version"`
		Candidates int64  `json:"candidates"`
		Token      string `json:"preview_token"`
	}
	if err := json.Unmarshal(preview.Body.Bytes(), &proposal); err != nil {
		t.Fatal(err)
	}
	if proposal.Version != 1 || proposal.Candidates != 1 || proposal.Token == "" {
		t.Fatalf("unexpected preview %+v", proposal)
	}
	patch := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPatch, "http://localhost/api/v1/settings", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://localhost")
		req.Header.Set("X-CSRF-Token", csrfBody.Token)
		req.AddCookie(csrf.Result().Cookies()[0])
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}
	if response := patch(`{"version":1,"retention_days":30}`); response.Code != http.StatusBadRequest {
		t.Fatalf("unconfirmed retention change status=%d body=%s", response.Code, response.Body.String())
	}
	if response := patch(`{"version":1,"retention_days":30,"retention_confirmation":"` + proposal.Token + `"}`); response.Code != http.StatusOK {
		t.Fatalf("confirmed retention change status=%d body=%s", response.Code, response.Body.String())
	}
	expired, err := st.ExpireContent(ctx, 100)
	if err != nil || expired.Messages != 1 {
		t.Fatalf("cleanup result=%+v err=%v", expired, err)
	}
}
