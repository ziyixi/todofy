package uiassets

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSPAEntryDoesNotRedirect(t *testing.T) {
	h, err := Handler()
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"/", "/messages", "/index.html"} {
		recorder := httptest.NewRecorder()
		h.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, route, nil))
		if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "<html") {
			t.Fatalf("%s: status %d, body %q", route, recorder.Code, recorder.Body.String())
		}
		if recorder.Header().Get("Location") != "" {
			t.Fatalf("%s redirected to %s", route, recorder.Header().Get("Location"))
		}
	}
}
