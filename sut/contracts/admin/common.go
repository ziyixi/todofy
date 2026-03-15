package admin

// ResetResponse acknowledges admin reset operations.
type ResetResponse struct {
	Status string `json:"status"`
}

// RecordedHTTPRequest captures one outbound provider request observed by a fake service.
type RecordedHTTPRequest struct {
	Method  string              `json:"method"`
	Path    string              `json:"path"`
	Query   string              `json:"query,omitempty"`
	Headers map[string][]string `json:"headers,omitempty"`
	Body    string              `json:"body,omitempty"`
}
