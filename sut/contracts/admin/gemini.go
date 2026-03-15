package admin

import sutgemini "github.com/ziyixi/todofy/sut/contracts/gemini"

// GeminiQueuedCountTokensResponse configures one queued count-tokens response.
type GeminiQueuedCountTokensResponse struct {
	StatusCode int                            `json:"status_code"`
	Headers    map[string]string              `json:"headers,omitempty"`
	Body       *sutgemini.CountTokensResponse `json:"body,omitempty"`
	RawBody    string                         `json:"raw_body,omitempty"`
}

// GeminiQueuedGenerateContentResponse configures one queued generate-content response.
type GeminiQueuedGenerateContentResponse struct {
	StatusCode int                                `json:"status_code"`
	Headers    map[string]string                  `json:"headers,omitempty"`
	Body       *sutgemini.GenerateContentResponse `json:"body,omitempty"`
	RawBody    string                             `json:"raw_body,omitempty"`
}

// SeedGeminiStateRequest replaces fake Gemini state.
type SeedGeminiStateRequest struct {
	CountTokensResponses     []GeminiQueuedCountTokensResponse     `json:"count_tokens_responses,omitempty"`
	GenerateContentResponses []GeminiQueuedGenerateContentResponse `json:"generate_content_responses,omitempty"`
}

// QueueGeminiResponsesRequest appends queued fake Gemini responses.
type QueueGeminiResponsesRequest = SeedGeminiStateRequest

// GeminiStateResponse returns fake Gemini state for assertions.
type GeminiStateResponse struct {
	CountTokensResponses     []GeminiQueuedCountTokensResponse     `json:"count_tokens_responses,omitempty"`
	GenerateContentResponses []GeminiQueuedGenerateContentResponse `json:"generate_content_responses,omitempty"`
	Calls                    []RecordedHTTPRequest                 `json:"calls,omitempty"`
}
