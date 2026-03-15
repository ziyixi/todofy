package gemini

const (
	CountTokensOperation     = ":countTokens"
	GenerateContentOperation = ":generateContent"
	ModelPathPrefix          = "/v1beta/models/"
)

// Part is the text-bearing subset of the Gemini content part payload used by Todofy.
type Part struct {
	Text string `json:"text,omitempty"`
}

// Content is the subset of the Gemini content payload used by Todofy.
type Content struct {
	Parts []Part `json:"parts,omitempty"`
	Role  string `json:"role,omitempty"`
}

// CountTokensRequest is the subset of the Gemini count-tokens request used by Todofy.
type CountTokensRequest struct {
	Contents []Content `json:"contents,omitempty"`
}

// CountTokensResponse is the subset of the Gemini count-tokens response used by Todofy.
type CountTokensResponse struct {
	TotalTokens             int32 `json:"totalTokens,omitempty"`
	CachedContentTokenCount int32 `json:"cachedContentTokenCount,omitempty"`
}

// Candidate is the subset of the Gemini generate-content candidate used by Todofy.
type Candidate struct {
	Content Content `json:"content,omitempty"`
}

// UsageMetadata is the subset of Gemini usage metadata used by Todofy.
type UsageMetadata struct {
	TotalTokenCount int32 `json:"totalTokenCount,omitempty"`
}

// GenerateContentRequest is the subset of the Gemini generate-content request used by Todofy.
type GenerateContentRequest struct {
	Contents []Content `json:"contents,omitempty"`
}

// GenerateContentResponse is the subset of the Gemini generate-content response used by Todofy.
type GenerateContentResponse struct {
	Candidates    []Candidate    `json:"candidates,omitempty"`
	ModelVersion  string         `json:"modelVersion,omitempty"`
	UsageMetadata *UsageMetadata `json:"usageMetadata,omitempty"`
}
