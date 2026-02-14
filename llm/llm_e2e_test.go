package main

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/genai"

	pb "github.com/ziyixi/protos/go/todofy"
)

const testAPIKey = "test-api-key"

// countTokensFn is the function signature for CountTokens mock.
type countTokensFn = func(
	ctx context.Context, model string, contents []*genai.Content,
) (*genai.CountTokensResponse, error)

// genContentFn is the function signature for GenerateContent mock.
type genContentFn = func(
	ctx context.Context, model string, contents []*genai.Content,
) (*genai.GenerateContentResponse, error)

// fakeGeminiClient is a mock implementation of geminiClient for testing.
type fakeGeminiClient struct {
	countTokens     countTokensFn
	generateContent genContentFn

	mu                   sync.Mutex
	countTokensCalls     int
	generateContentCalls int
	lastModel            string
	lastContents         []*genai.Content
}

func (f *fakeGeminiClient) CountTokens(
	ctx context.Context, model string, contents []*genai.Content,
) (*genai.CountTokensResponse, error) {
	f.mu.Lock()
	f.countTokensCalls++
	f.lastModel = model
	f.lastContents = contents
	f.mu.Unlock()

	if f.countTokens != nil {
		return f.countTokens(ctx, model, contents)
	}
	return &genai.CountTokensResponse{TotalTokens: 100}, nil
}

func (f *fakeGeminiClient) GenerateContent(
	ctx context.Context, model string, contents []*genai.Content,
) (*genai.GenerateContentResponse, error) {
	f.mu.Lock()
	f.generateContentCalls++
	f.lastModel = model
	f.lastContents = contents
	f.mu.Unlock()

	if f.generateContent != nil {
		return f.generateContent(ctx, model, contents)
	}
	return &genai.GenerateContentResponse{
		Candidates: []*genai.Candidate{
			{
				Content: &genai.Content{
					Parts: []*genai.Part{
						{Text: "This is a test summary."},
					},
				},
			},
		},
		UsageMetadata: &genai.GenerateContentResponseUsageMetadata{
			TotalTokenCount: 150,
		},
	}, nil
}

func newFakeClientFactory(
	fake *fakeGeminiClient,
) func(ctx context.Context, apiKey string) (geminiClient, error) {
	return func(
		ctx context.Context, apiKey string,
	) (geminiClient, error) {
		return fake, nil
	}
}

func newFailingClientFactory(
	err error,
) func(ctx context.Context, apiKey string) (geminiClient, error) {
	return func(
		ctx context.Context, apiKey string,
	) (geminiClient, error) {
		return nil, err
	}
}

// setupTestServer creates an llmServer with a fake client and tracker.
func setupTestServer(
	fake *fakeGeminiClient, limit int32,
) *llmServer {
	originalKey := *geminiAPIKey
	*geminiAPIKey = testAPIKey
	_ = originalKey // will be restored in test cleanup

	tracker := NewTokenTracker(24*time.Hour, limit)
	return &llmServer{
		tracker:       tracker,
		clientFactory: newFakeClientFactory(fake),
	}
}

// makeSuccessResp builds a standard success GenerateContentResponse.
func makeSuccessResp(
	text string, tokenCount int32,
) *genai.GenerateContentResponse {
	resp := &genai.GenerateContentResponse{
		Candidates: []*genai.Candidate{
			{Content: &genai.Content{
				Parts: []*genai.Part{{Text: text}},
			}},
		},
	}
	if tokenCount > 0 {
		resp.UsageMetadata = &genai.GenerateContentResponseUsageMetadata{
			TotalTokenCount: tokenCount,
		}
	}
	return resp
}

// --- E2E Tests: Full Summarize Flow ---

func TestE2E_Summarize_Success(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize this email:",
		Text:        "Hello, this is a test email with some content.",
	}

	resp, err := server.Summarize(context.Background(), req)

	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, "This is a test summary.", resp.Summary)
	assert.Equal(t, pb.Model_MODEL_GEMINI_2_5_FLASH_LITE, resp.Model)

	// Verify mock was called correctly
	assert.Equal(t, 1, fake.countTokensCalls)
	assert.Equal(t, 1, fake.generateContentCalls)
	assert.Equal(t, "gemini-2.5-flash-lite", fake.lastModel)
}

func TestE2E_Summarize_ModelFallback(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	callCount := 0
	fake := &fakeGeminiClient{
		generateContent: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.GenerateContentResponse, error) {
			callCount++
			if model == "gemini-2.5-flash-lite" {
				return nil, fmt.Errorf("model overloaded")
			}
			return makeSuccessResp("Fallback summary.", 200), nil
		},
	}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Prompt:      "Summarize:",
		Text:        "Test content",
	}

	resp, err := server.Summarize(context.Background(), req)

	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, "Fallback summary.", resp.Summary)
	assert.Equal(t, pb.Model_MODEL_GEMINI_2_5_FLASH, resp.Model)
}

func TestE2E_Summarize_AllModelsFail(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{
		generateContent: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.GenerateContentResponse, error) {
			return nil, fmt.Errorf("all models fail")
		},
	}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Prompt:      "Summarize:",
		Text:        "Test content",
	}

	resp, err := server.Summarize(context.Background(), req)

	assert.Error(t, err)
	assert.Nil(t, resp)
	assert.Contains(t, err.Error(), "failed to generate summary")
}

func TestE2E_Summarize_UnsupportedModelFamily(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_UNSPECIFIED,
		Prompt:      "Summarize:",
		Text:        "Test content",
	}

	resp, err := server.Summarize(context.Background(), req)

	assert.Error(t, err)
	assert.Nil(t, resp)
	assert.Contains(t, err.Error(), "unsupported model family")

	assert.Equal(t, 0, fake.countTokensCalls)
	assert.Equal(t, 0, fake.generateContentCalls)
}

func TestE2E_Summarize_SpecificModel(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH,
		Prompt:      "Summarize:",
		Text:        "Test content",
	}

	resp, err := server.Summarize(context.Background(), req)

	require.NoError(t, err)
	assert.Equal(t, pb.Model_MODEL_GEMINI_2_5_FLASH, resp.Model)
	assert.Equal(t, "gemini-2.5-flash", fake.lastModel)
}

// --- E2E Tests: Token Limit Enforcement ---

// TestE2E_Summarize_TokenLimitBoundary uses table-driven subtests
// to cover both exceeded and exact-boundary scenarios (avoids dupl).
func TestE2E_Summarize_TokenLimitBoundary(t *testing.T) {
	tests := []struct {
		name        string
		limit       int
		trackerLim  int32
		tokensPerOp int32
		text        string
	}{
		{
			name:        "exceeded",
			limit:       1000,
			trackerLim:  1000,
			tokensPerOp: 500,
			text:        "Test content",
		},
		{
			name:        "exact_boundary",
			limit:       500,
			trackerLim:  500,
			tokensPerOp: 250,
			text:        "Test",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			originalKey := *geminiAPIKey
			defer func() { *geminiAPIKey = originalKey }()
			originalLimit := *dailyTokenLimit
			defer func() { *dailyTokenLimit = originalLimit }()
			*dailyTokenLimit = tc.limit

			tokens := tc.tokensPerOp
			fake := &fakeGeminiClient{
				countTokens: func(
					ctx context.Context, model string,
					contents []*genai.Content,
				) (*genai.CountTokensResponse, error) {
					return &genai.CountTokensResponse{
						TotalTokens: tokens,
					}, nil
				},
				generateContent: func(
					ctx context.Context, model string,
					contents []*genai.Content,
				) (*genai.GenerateContentResponse, error) {
					return makeSuccessResp("Summary", tokens), nil
				},
			}
			server := setupTestServer(fake, tc.trackerLim)

			req := &pb.LLMSummaryRequest{
				ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
				Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
				Prompt:      "Summarize:",
				Text:        tc.text,
			}

			// First call succeeds
			resp, err := server.Summarize(
				context.Background(), req,
			)
			require.NoError(t, err)
			require.NotNil(t, resp)

			// Second call succeeds (at limit)
			resp, err = server.Summarize(
				context.Background(), req,
			)
			require.NoError(t, err)
			require.NotNil(t, resp)

			// Third call exceeds limit
			resp, err = server.Summarize(
				context.Background(), req,
			)
			assert.Error(t, err)
			assert.Nil(t, resp)
			assert.Contains(t,
				err.Error(), "failed to generate summary")
		})
	}
}

func TestE2E_Summarize_TokenLimitUnlimited(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{
		countTokens: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.CountTokensResponse, error) {
			return &genai.CountTokensResponse{
				TotalTokens: 999999,
			}, nil
		},
	}
	server := setupTestServer(fake, 0) // unlimited

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test content",
	}

	for i := 0; i < 5; i++ {
		resp, err := server.Summarize(context.Background(), req)
		require.NoError(t, err)
		require.NotNil(t, resp)
	}
}

func TestE2E_Summarize_TokenUsageTracking(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{
		countTokens: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.CountTokensResponse, error) {
			return &genai.CountTokensResponse{
				TotalTokens: 100,
			}, nil
		},
		generateContent: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.GenerateContentResponse, error) {
			return makeSuccessResp("Summary", 250), nil
		},
	}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test content",
	}

	for i := 0; i < 3; i++ {
		_, err := server.Summarize(context.Background(), req)
		require.NoError(t, err)
	}

	// 250 * 3 = 750 total tokens
	assert.Equal(t, int32(750), server.tracker.CurrentUsage())
}

func TestE2E_Summarize_TokenUsageFallsBackToCountTokens(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{
		countTokens: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.CountTokensResponse, error) {
			return &genai.CountTokensResponse{
				TotalTokens: 300,
			}, nil
		},
		generateContent: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.GenerateContentResponse, error) {
			// No UsageMetadata — falls back to CountTokens
			return makeSuccessResp("Summary", 0), nil
		},
	}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test content",
	}

	_, err := server.Summarize(context.Background(), req)
	require.NoError(t, err)

	assert.Equal(t, int32(300), server.tracker.CurrentUsage())
}

// --- E2E Tests: Token Truncation ---

func TestE2E_Summarize_ContentTruncatedWhenOverTokenLimit(
	t *testing.T,
) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	countCalls := 0
	fake := &fakeGeminiClient{
		countTokens: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.CountTokensResponse, error) {
			countCalls++
			if countCalls == 1 {
				return &genai.CountTokensResponse{
					TotalTokens: 2000000,
				}, nil
			}
			return &genai.CountTokensResponse{
				TotalTokens: 500,
			}, nil
		},
	}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        strings.Repeat("A", 100000),
		MaxTokens:   1000000,
	}

	resp, err := server.Summarize(context.Background(), req)

	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.GreaterOrEqual(t, countCalls, 2)
}

func TestE2E_Summarize_CustomMaxTokens(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	countCalls := 0
	fake := &fakeGeminiClient{
		countTokens: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.CountTokensResponse, error) {
			countCalls++
			if countCalls == 1 {
				return &genai.CountTokensResponse{
					TotalTokens: 600,
				}, nil
			}
			return &genai.CountTokensResponse{
				TotalTokens: 400,
			}, nil
		},
	}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test content",
		MaxTokens:   500,
	}

	resp, err := server.Summarize(context.Background(), req)

	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.GreaterOrEqual(t, countCalls, 2)
}

// --- E2E Tests: Token Sliding Window ---

func TestE2E_Summarize_SlidingWindowExpiry(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()
	originalLimit := *dailyTokenLimit
	defer func() { *dailyTokenLimit = originalLimit }()
	*dailyTokenLimit = 1000

	fake := &fakeGeminiClient{
		countTokens: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.CountTokensResponse, error) {
			return &genai.CountTokensResponse{
				TotalTokens: 400,
			}, nil
		},
		generateContent: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.GenerateContentResponse, error) {
			return makeSuccessResp("Summary", 400), nil
		},
	}

	tracker := NewTokenTracker(24*time.Hour, 1000)
	server := &llmServer{
		tracker:       tracker,
		clientFactory: newFakeClientFactory(fake),
	}
	*geminiAPIKey = testAPIKey

	now := time.Now()

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test content",
	}

	// Simulate old usage (25h ago) that should expire
	tracker.timeFunc = func() time.Time {
		return now.Add(-25 * time.Hour)
	}
	tracker.Record(800)

	// Should succeed because old record is outside window
	tracker.timeFunc = func() time.Time { return now }
	resp, err := server.Summarize(context.Background(), req)
	require.NoError(t, err)
	require.NotNil(t, resp)
}

// --- E2E Tests: Error Handling ---

func TestE2E_Summarize_ClientCreationFails(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()
	*geminiAPIKey = testAPIKey

	tracker := NewTokenTracker(24*time.Hour, 3000000)
	server := &llmServer{
		tracker: tracker,
		clientFactory: newFailingClientFactory(
			fmt.Errorf("connection refused"),
		),
	}

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test content",
	}

	resp, err := server.Summarize(context.Background(), req)
	assert.Error(t, err)
	assert.Nil(t, resp)
	assert.Contains(t, err.Error(), "failed to generate summary")
}

func TestE2E_Summarize_CountTokensFails(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{
		countTokens: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.CountTokensResponse, error) {
			return nil, fmt.Errorf("quota exceeded")
		},
	}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test",
	}

	resp, err := server.Summarize(context.Background(), req)
	assert.Error(t, err)
	assert.Nil(t, resp)
	assert.Contains(t, err.Error(), "failed to generate summary")
}

func TestE2E_Summarize_EmptyResponse(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{
		generateContent: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.GenerateContentResponse, error) {
			return &genai.GenerateContentResponse{
				Candidates: []*genai.Candidate{},
			}, nil
		},
	}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test",
	}

	resp, err := server.Summarize(context.Background(), req)
	assert.Error(t, err)
	assert.Nil(t, resp)
}

func TestE2E_Summarize_NoCandidateContent(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{
		generateContent: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.GenerateContentResponse, error) {
			return &genai.GenerateContentResponse{
				Candidates: []*genai.Candidate{
					{Content: nil},
				},
			}, nil
		},
	}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test",
	}

	resp, err := server.Summarize(context.Background(), req)
	assert.Error(t, err)
	assert.Nil(t, resp)
}

func TestE2E_Summarize_NoContentParts(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{
		generateContent: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.GenerateContentResponse, error) {
			return &genai.GenerateContentResponse{
				Candidates: []*genai.Candidate{
					{Content: &genai.Content{
						Parts: []*genai.Part{},
					}},
				},
			}, nil
		},
	}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test",
	}

	resp, err := server.Summarize(context.Background(), req)
	assert.Error(t, err)
	assert.Nil(t, resp)
}

// --- E2E Tests: No API Key ---

func TestE2E_Summarize_NoAPIKey(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()
	*geminiAPIKey = ""

	fake := &fakeGeminiClient{}
	tracker := NewTokenTracker(24*time.Hour, 3000000)
	server := &llmServer{
		tracker:       tracker,
		clientFactory: newFakeClientFactory(fake),
	}

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test",
	}

	resp, err := server.Summarize(context.Background(), req)
	assert.Error(t, err)
	assert.Nil(t, resp)
	assert.Contains(t, err.Error(), "failed to generate summary")

	assert.Equal(t, 0, fake.countTokensCalls)
	assert.Equal(t, 0, fake.generateContentCalls)
}

// --- E2E Tests: Multiple Sequential Requests ---

func TestE2E_Summarize_MultipleSequentialRequests(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	callNum := 0
	fake := &fakeGeminiClient{
		generateContent: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.GenerateContentResponse, error) {
			callNum++
			return makeSuccessResp(
				fmt.Sprintf("Summary %d", callNum), 100,
			), nil
		},
	}
	server := setupTestServer(fake, 3000000)

	for i := 1; i <= 5; i++ {
		req := &pb.LLMSummaryRequest{
			ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
			Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
			Prompt:      "Summarize:",
			Text:        fmt.Sprintf("Email content %d", i),
		}

		resp, err := server.Summarize(context.Background(), req)
		require.NoError(t, err)
		assert.Equal(t,
			fmt.Sprintf("Summary %d", i), resp.Summary)
	}

	// 5 requests * 100 tokens = 500 total
	assert.Equal(t, int32(500), server.tracker.CurrentUsage())
}

// --- E2E Tests: Prompt + Text Concatenation ---

func TestE2E_Summarize_PromptAndTextConcatenated(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	var capturedText string
	fake := &fakeGeminiClient{
		countTokens: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.CountTokensResponse, error) {
			if len(contents) > 0 && len(contents[0].Parts) > 0 {
				capturedText = contents[0].Parts[0].Text
			}
			return &genai.CountTokensResponse{
				TotalTokens: 100,
			}, nil
		},
	}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Please summarize:",
		Text:        "This is the email body.",
	}

	_, err := server.Summarize(context.Background(), req)
	require.NoError(t, err)

	assert.Equal(t,
		"Please summarize:\nThis is the email body.", capturedText)
}

// --- E2E Tests: Token Tracking Not Recorded on Failure ---

func TestE2E_Summarize_TokensNotRecordedOnFailure(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{
		generateContent: func(
			ctx context.Context, model string,
			contents []*genai.Content,
		) (*genai.GenerateContentResponse, error) {
			return nil, fmt.Errorf("API error")
		},
	}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test",
	}

	_, err := server.Summarize(context.Background(), req)
	assert.Error(t, err)

	// Tokens should NOT be recorded since generation failed
	assert.Equal(t, int32(0), server.tracker.CurrentUsage())
}
