package delivery

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestTargetPolicy(t *testing.T) {
	if !errors.Is(ValidateTargetURL("http://127.0.0.1:8080/hook", nil), ErrTargetBlocked) {
		t.Fatal("loopback should be blocked")
	}
	if err := ValidateTargetURL("http://127.0.0.1:8080/hook", []string{"127.0.0.1:8080"}); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(ValidateTargetURL("https://user:pass@example.org/hook", nil), ErrTargetBlocked) {
		t.Fatal("userinfo should be blocked")
	}
}
func TestPostPreservesEventAndDoesNotFollowRedirect(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Idempotency-Key") != "event" {
			t.Errorf("wrong idempotency key")
		}
		w.Header().Set("Location", "/another")
		w.WriteHeader(http.StatusFound)
	}))
	defer server.Close()
	host := server.Listener.Addr().String()
	status, _, _, err := Post(t.Context(), server.URL, "none", "", "event", []byte(`{"hello":1}`), []string{host}, time.Second)
	if err != nil || status != 302 || calls != 1 {
		t.Fatalf("status=%d calls=%d err=%v", status, calls, err)
	}
}

func TestRetryAfterLargeValueCannotOverflow(t *testing.T) {
	now := time.Now().UTC()
	deadline, err := RetryAfter("9223372036854775807", now)
	if err != nil || !deadline.After(now.Add(24*time.Hour)) {
		t.Fatalf("deadline=%v err=%v", deadline, err)
	}
}
