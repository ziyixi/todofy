package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"

	admincontract "github.com/ziyixi/todofy/sut/contracts/admin"
	geminicontract "github.com/ziyixi/todofy/sut/contracts/gemini"
)

var (
	port           = flag.Int("port", 8080, "Port for the fake Gemini service")
	expectedAPIKey = flag.String("expected-api-key", "", "Expected x-goog-api-key header value")
)

type server struct {
	mu sync.Mutex

	countTokensResponses     []admincontract.GeminiQueuedCountTokensResponse
	generateContentResponses []admincontract.GeminiQueuedGenerateContentResponse
	calls                    []admincontract.RecordedHTTPRequest
}

func main() {
	flag.Parse()

	srv := &server{}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/admin/reset", srv.handleAdminReset)
	mux.HandleFunc("/admin/seed", srv.handleAdminSeed)
	mux.HandleFunc("/admin/queue", srv.handleAdminQueue)
	mux.HandleFunc("/admin/state", srv.handleAdminState)
	mux.HandleFunc("/", srv.handleGemini)

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("fake gemini listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("fake gemini server failed: %v", err)
	}
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) handleAdminReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	s.mu.Lock()
	s.countTokensResponses = nil
	s.generateContentResponses = nil
	s.calls = nil
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, admincontract.ResetResponse{Status: "ok"})
}

func (s *server) handleAdminSeed(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req admincontract.SeedGeminiStateRequest
	if err := decodeJSON(r.Body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	s.mu.Lock()
	s.countTokensResponses = append(
		[]admincontract.GeminiQueuedCountTokensResponse(nil),
		req.CountTokensResponses...,
	)
	s.generateContentResponses = append(
		[]admincontract.GeminiQueuedGenerateContentResponse(nil),
		req.GenerateContentResponses...,
	)
	s.calls = nil
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, admincontract.ResetResponse{Status: "ok"})
}

func (s *server) handleAdminQueue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req admincontract.QueueGeminiResponsesRequest
	if err := decodeJSON(r.Body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	s.mu.Lock()
	s.countTokensResponses = append(s.countTokensResponses, req.CountTokensResponses...)
	s.generateContentResponses = append(s.generateContentResponses, req.GenerateContentResponses...)
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, admincontract.ResetResponse{Status: "ok"})
}

func (s *server) handleAdminState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	s.mu.Lock()
	resp := admincontract.GeminiStateResponse{
		CountTokensResponses: append(
			[]admincontract.GeminiQueuedCountTokensResponse(nil),
			s.countTokensResponses...,
		),
		GenerateContentResponses: append(
			[]admincontract.GeminiQueuedGenerateContentResponse(nil),
			s.generateContentResponses...,
		),
		Calls: append([]admincontract.RecordedHTTPRequest(nil), s.calls...),
	}
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, resp)
}

func (s *server) handleGemini(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if !strings.HasPrefix(r.URL.Path, geminicontract.ModelPathPrefix) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read request body"})
		return
	}
	s.recordCall(r, body)

	if *expectedAPIKey != "" && strings.TrimSpace(r.Header.Get("x-goog-api-key")) != *expectedAPIKey {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid api key"})
		return
	}

	switch {
	case strings.HasSuffix(r.URL.Path, geminicontract.CountTokensOperation):
		s.handleCountTokens(w, body)
	case strings.HasSuffix(r.URL.Path, geminicontract.GenerateContentOperation):
		s.handleGenerateContent(w, r.URL.Path, body)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unsupported operation"})
	}
}

func (s *server) handleCountTokens(w http.ResponseWriter, body []byte) {
	var req geminicontract.CountTokensRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid countTokens request"})
		return
	}

	if queued, ok := s.popCountTokensResponse(); ok {
		writeGeminiCountTokensResponse(w, queued)
		return
	}

	resp := geminicontract.CountTokensResponse{
		TotalTokens: estimateTokenCount(req.Contents),
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *server) handleGenerateContent(w http.ResponseWriter, path string, body []byte) {
	var req geminicontract.GenerateContentRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid generateContent request"})
		return
	}

	if queued, ok := s.popGenerateContentResponse(); ok {
		writeGeminiGenerateContentResponse(w, queued)
		return
	}

	modelName := extractModelName(path, geminicontract.GenerateContentOperation)
	text := joinedText(req.Contents)
	if strings.TrimSpace(text) == "" {
		text = "fake generated content"
	}
	resp := geminicontract.GenerateContentResponse{
		Candidates: []geminicontract.Candidate{
			{
				Content: geminicontract.Content{
					Parts: []geminicontract.Part{
						{Text: fmt.Sprintf("fake response for %s: %s", modelName, text)},
					},
				},
			},
		},
		ModelVersion: modelName,
		UsageMetadata: &geminicontract.UsageMetadata{
			TotalTokenCount: estimateTokenCount(req.Contents),
		},
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *server) popCountTokensResponse() (admincontract.GeminiQueuedCountTokensResponse, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.countTokensResponses) == 0 {
		return admincontract.GeminiQueuedCountTokensResponse{}, false
	}
	resp := s.countTokensResponses[0]
	s.countTokensResponses = append([]admincontract.GeminiQueuedCountTokensResponse(nil), s.countTokensResponses[1:]...)
	return resp, true
}

func (s *server) popGenerateContentResponse() (admincontract.GeminiQueuedGenerateContentResponse, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.generateContentResponses) == 0 {
		return admincontract.GeminiQueuedGenerateContentResponse{}, false
	}
	resp := s.generateContentResponses[0]
	s.generateContentResponses = append(
		[]admincontract.GeminiQueuedGenerateContentResponse(nil),
		s.generateContentResponses[1:]...,
	)
	return resp, true
}

func (s *server) recordCall(r *http.Request, body []byte) {
	call := admincontract.RecordedHTTPRequest{
		Method:  r.Method,
		Path:    r.URL.Path,
		Query:   r.URL.RawQuery,
		Headers: cloneHeaders(r.Header),
		Body:    string(body),
	}

	s.mu.Lock()
	s.calls = append(s.calls, call)
	s.mu.Unlock()
}

func writeGeminiCountTokensResponse(w http.ResponseWriter, resp admincontract.GeminiQueuedCountTokensResponse) {
	writeConfiguredResponse(w, resp.StatusCode, resp.Headers, resp.RawBody, resp.Body)
}

func writeGeminiGenerateContentResponse(w http.ResponseWriter, resp admincontract.GeminiQueuedGenerateContentResponse) {
	writeConfiguredResponse(w, resp.StatusCode, resp.Headers, resp.RawBody, resp.Body)
}

func writeConfiguredResponse(
	w http.ResponseWriter,
	statusCode int,
	headers map[string]string,
	rawBody string,
	body any,
) {
	if statusCode == 0 {
		statusCode = http.StatusOK
	}
	for key, value := range headers {
		w.Header().Set(key, value)
	}
	if rawBody != "" {
		if w.Header().Get("Content-Type") == "" {
			w.Header().Set("Content-Type", "application/json")
		}
		w.WriteHeader(statusCode)
		_, _ = w.Write([]byte(rawBody))
		return
	}
	writeJSON(w, statusCode, body)
}

func writeJSON(w http.ResponseWriter, statusCode int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	if value == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("failed to encode response: %v", err)
	}
}

func decodeJSON(r io.Reader, out any) error {
	decoder := json.NewDecoder(r)
	if err := decoder.Decode(out); err != nil {
		return err
	}
	return nil
}

func cloneHeaders(headers http.Header) map[string][]string {
	out := make(map[string][]string, len(headers))
	for key, values := range headers {
		out[key] = append([]string(nil), values...)
	}
	return out
}

func extractModelName(path string, suffix string) string {
	trimmed := strings.TrimPrefix(path, geminicontract.ModelPathPrefix)
	trimmed = strings.TrimSuffix(trimmed, suffix)
	return strings.TrimPrefix(trimmed, "models/")
}

func joinedText(contents []geminicontract.Content) string {
	parts := make([]string, 0, len(contents))
	for _, content := range contents {
		for _, part := range content.Parts {
			if strings.TrimSpace(part.Text) == "" {
				continue
			}
			parts = append(parts, part.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func estimateTokenCount(contents []geminicontract.Content) int32 {
	text := joinedText(contents)
	if strings.TrimSpace(text) == "" {
		return 1
	}
	return int32(len([]rune(text)))
}
