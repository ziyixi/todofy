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

// fakeGeminiClient is a mock implementation of geminiClient for testing.
type fakeGeminiClient struct {
	// countTokensFunc allows per-test customization of CountTokens behavior.
	countTokensFunc func(ctx context.Context, model string, contents []*genai.Content) (*genai.CountTokensResponse, error)
	// generateContentFunc allows per-test customization of GenerateContent behavior.
	generateContentFunc func(ctx context.Context, model string, contents []*genai.Content) (*genai.GenerateContentResponse, error)

	mu                   sync.Mutex
	countTokensCalls     int
	generateContentCalls int
	lastModel            string
	lastContents         []*genai.Content
}

func (f *fakeGeminiClient) CountTokens(ctx context.Context, model string, contents []*genai.Content) (*genai.CountTokensResponse, error) {
	f.mu.Lock()
	f.countTokensCalls++
	f.lastModel = model
	f.lastContents = contents
	f.mu.Unlock()

	if f.countTokensFunc != nil {
		return f.countTokensFunc(ctx, model, contents)
	}
	return &genai.CountTokensResponse{TotalTokens: 100}, nil
}

func (f *fakeGeminiClient) GenerateContent(ctx context.Context, model string, contents []*genai.Content) (*genai.GenerateContentResponse, error) {
	f.mu.Lock()
	f.generateContentCalls++
	f.lastModel = model
	f.lastContents = contents
	f.mu.Unlock()

	if f.generateContentFunc != nil {
		return f.generateContentFunc(ctx, model, contents)
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

func newFakeClientFactory(fake *fakeGeminiClient) func(ctx context.Context, apiKey string) (geminiClient, error) {
	return func(ctx context.Context, apiKey string) (geminiClient, error) {
		return fake, nil
	}
}

func newFailingClientFactory(err error) func(ctx context.Context, apiKey string) (geminiClient, error) {
	return func(ctx context.Context, apiKey string) (geminiClient, error) {
		return nil, err
	}
}

// setupTestServer creates an llmServer with a fake Gemini client and token tracker.
func setupTestServer(fake *fakeGeminiClient, tokenLimit int32) *llmServer {
	// Ensure API key is set for tests
	originalKey := *geminiAPIKey
	*geminiAPIKey = "test-api-key"
	_ = originalKey // will be restored in test cleanup

	tracker := NewTokenTracker(24*time.Hour, tokenLimit)
	return &llmServer{
		tracker:       tracker,
		clientFactory: newFakeClientFactory(fake),
	}
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
		generateContentFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.GenerateContentResponse, error) {
			callCount++
			// First model fails, second succeeds
			if model == "gemini-2.5-flash-lite" {
				return nil, fmt.Errorf("model overloaded")
			}
			return &genai.GenerateContentResponse{
				Candidates: []*genai.Candidate{
					{Content: &genai.Content{Parts: []*genai.Part{{Text: "Fallback summary."}}}},
				},
				UsageMetadata: &genai.GenerateContentResponseUsageMetadata{TotalTokenCount: 200},
			}, nil
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
	// Should have fallen back to second model in priority
	assert.Equal(t, pb.Model_MODEL_GEMINI_2_5_FLASH, resp.Model)
}

func TestE2E_Summarize_AllModelsFail(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{
		generateContentFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.GenerateContentResponse, error) {
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

	// Should not have called the API at all
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

func TestE2E_Summarize_TokenLimitExceeded(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()
	originalLimit := *dailyTokenLimit
	defer func() { *dailyTokenLimit = originalLimit }()
	*dailyTokenLimit = 1000

	fake := &fakeGeminiClient{
		countTokensFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.CountTokensResponse, error) {
			return &genai.CountTokensResponse{TotalTokens: 500}, nil
		},
		generateContentFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.GenerateContentResponse, error) {
			return &genai.GenerateContentResponse{
				Candidates: []*genai.Candidate{
					{Content: &genai.Content{Parts: []*genai.Part{{Text: "Summary"}}}},
				},
				UsageMetadata: &genai.GenerateContentResponseUsageMetadata{TotalTokenCount: 500},
			}, nil
		},
	}
	server := setupTestServer(fake, 1000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test content",
	}

	// First call succeeds (500 tokens recorded)
	resp, err := server.Summarize(context.Background(), req)
	require.NoError(t, err)
	require.NotNil(t, resp)

	// Second call succeeds (500+500=1000 tokens, at limit)
	resp, err = server.Summarize(context.Background(), req)
	require.NoError(t, err)
	require.NotNil(t, resp)

	// Third call should fail (1000+500=1500 would exceed 1000 limit)
	resp, err = server.Summarize(context.Background(), req)
	assert.Error(t, err)
	assert.Nil(t, resp)
	assert.Contains(t, err.Error(), "failed to generate summary")
}

func TestE2E_Summarize_TokenLimitUnlimited(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{
		countTokensFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.CountTokensResponse, error) {
			return &genai.CountTokensResponse{TotalTokens: 999999}, nil
		},
	}
	server := setupTestServer(fake, 0) // unlimited

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test content",
	}

	// Should succeed even with huge token counts when limit is disabled
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
		countTokensFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.CountTokensResponse, error) {
			return &genai.CountTokensResponse{TotalTokens: 100}, nil
		},
		generateContentFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.GenerateContentResponse, error) {
			return &genai.GenerateContentResponse{
				Candidates: []*genai.Candidate{
					{Content: &genai.Content{Parts: []*genai.Part{{Text: "Summary"}}}},
				},
				UsageMetadata: &genai.GenerateContentResponseUsageMetadata{
					TotalTokenCount: 250, // input + output
				},
			}, nil
		},
	}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test content",
	}

	// Make 3 calls
	for i := 0; i < 3; i++ {
		_, err := server.Summarize(context.Background(), req)
		require.NoError(t, err)
	}

	// Should have recorded 250 * 3 = 750 total tokens
	assert.Equal(t, int32(750), server.tracker.CurrentUsage())
}

func TestE2E_Summarize_TokenUsageFallsBackToCountTokens(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{
		countTokensFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.CountTokensResponse, error) {
			return &genai.CountTokensResponse{TotalTokens: 300}, nil
		},
		generateContentFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.GenerateContentResponse, error) {
			// No UsageMetadata - should fall back to CountTokens value
			return &genai.GenerateContentResponse{
				Candidates: []*genai.Candidate{
					{Content: &genai.Content{Parts: []*genai.Part{{Text: "Summary"}}}},
				},
			}, nil
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

	// Should use CountTokens value (300) since UsageMetadata is nil
	assert.Equal(t, int32(300), server.tracker.CurrentUsage())
}

// --- E2E Tests: Token Truncation ---

func TestE2E_Summarize_ContentTruncatedWhenOverTokenLimit(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	countCalls := 0
	fake := &fakeGeminiClient{
		countTokensFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.CountTokensResponse, error) {
			countCalls++
			// First call returns over limit, subsequent calls return under
			if countCalls == 1 {
				return &genai.CountTokensResponse{TotalTokens: 2000000}, nil
			}
			return &genai.CountTokensResponse{TotalTokens: 500}, nil
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
	// CountTokens should have been called at least twice (initial + after truncation)
	assert.GreaterOrEqual(t, countCalls, 2)
}

func TestE2E_Summarize_CustomMaxTokens(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	countCalls := 0
	fake := &fakeGeminiClient{
		countTokensFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.CountTokensResponse, error) {
			countCalls++
			if countCalls == 1 {
				return &genai.CountTokensResponse{TotalTokens: 600}, nil
			}
			return &genai.CountTokensResponse{TotalTokens: 400}, nil
		},
	}
	server := setupTestServer(fake, 3000000)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test content",
		MaxTokens:   500, // Custom low token limit
	}

	resp, err := server.Summarize(context.Background(), req)

	require.NoError(t, err)
	require.NotNil(t, resp)
	// Content should have been truncated because initial 600 > 500
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
		countTokensFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.CountTokensResponse, error) {
			return &genai.CountTokensResponse{TotalTokens: 400}, nil
		},
		generateContentFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.GenerateContentResponse, error) {
			return &genai.GenerateContentResponse{
				Candidates: []*genai.Candidate{
					{Content: &genai.Content{Parts: []*genai.Part{{Text: "Summary"}}}},
				},
				UsageMetadata: &genai.GenerateContentResponseUsageMetadata{TotalTokenCount: 400},
			}, nil
		},
	}

	tracker := NewTokenTracker(24*time.Hour, 1000)
	server := &llmServer{
		tracker:       tracker,
		clientFactory: newFakeClientFactory(fake),
	}
	*geminiAPIKey = "test-api-key"

	now := time.Now()

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test content",
	}

	// Simulate old usage (25 hours ago) that should expire
	tracker.timeFunc = func() time.Time { return now.Add(-25 * time.Hour) }
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
	*geminiAPIKey = "test-api-key"

	tracker := NewTokenTracker(24*time.Hour, 3000000)
	server := &llmServer{
		tracker:       tracker,
		clientFactory: newFailingClientFactory(fmt.Errorf("connection refused")),
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
		countTokensFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.CountTokensResponse, error) {
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
		generateContentFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.GenerateContentResponse, error) {
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
		generateContentFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.GenerateContentResponse, error) {
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
		generateContentFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.GenerateContentResponse, error) {
			return &genai.GenerateContentResponse{
				Candidates: []*genai.Candidate{
					{Content: &genai.Content{Parts: []*genai.Part{}}},
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

	// Should not have called the API
	assert.Equal(t, 0, fake.countTokensCalls)
	assert.Equal(t, 0, fake.generateContentCalls)
}

// --- E2E Tests: Multiple Sequential Requests ---

func TestE2E_Summarize_MultipleSequentialRequests(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	callNum := 0
	fake := &fakeGeminiClient{
		generateContentFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.GenerateContentResponse, error) {
			callNum++
			return &genai.GenerateContentResponse{
				Candidates: []*genai.Candidate{
					{Content: &genai.Content{Parts: []*genai.Part{{Text: fmt.Sprintf("Summary %d", callNum)}}}},
				},
				UsageMetadata: &genai.GenerateContentResponseUsageMetadata{TotalTokenCount: 100},
			}, nil
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
		assert.Equal(t, fmt.Sprintf("Summary %d", i), resp.Summary)
	}

	// 5 requests * 100 tokens = 500 total
	assert.Equal(t, int32(500), server.tracker.CurrentUsage())
}

// --- E2E Tests: Token Limit Boundary ---

func TestE2E_Summarize_TokenLimitExactBoundary(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()
	originalLimit := *dailyTokenLimit
	defer func() { *dailyTokenLimit = originalLimit }()
	*dailyTokenLimit = 500

	fake := &fakeGeminiClient{
		countTokensFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.CountTokensResponse, error) {
			return &genai.CountTokensResponse{TotalTokens: 250}, nil
		},
		generateContentFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.GenerateContentResponse, error) {
			return &genai.GenerateContentResponse{
				Candidates: []*genai.Candidate{
					{Content: &genai.Content{Parts: []*genai.Part{{Text: "Summary"}}}},
				},
				UsageMetadata: &genai.GenerateContentResponseUsageMetadata{TotalTokenCount: 250},
			}, nil
		},
	}
	server := setupTestServer(fake, 500)

	req := &pb.LLMSummaryRequest{
		ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
		Model:       pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		Prompt:      "Summarize:",
		Text:        "Test",
	}

	// First call: 250 tokens, within limit
	resp, err := server.Summarize(context.Background(), req)
	require.NoError(t, err)
	require.NotNil(t, resp)

	// Second call: 250 + 250 = 500, exactly at limit, should pass
	resp, err = server.Summarize(context.Background(), req)
	require.NoError(t, err)
	require.NotNil(t, resp)

	// Third call: 500 + 250 = 750, exceeds 500 limit
	resp, err = server.Summarize(context.Background(), req)
	assert.Error(t, err)
	assert.Nil(t, resp)
	assert.Contains(t, err.Error(), "failed to generate summary")
}

// --- E2E Tests: Prompt + Text Concatenation ---

func TestE2E_Summarize_PromptAndTextConcatenated(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	var capturedText string
	fake := &fakeGeminiClient{
		countTokensFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.CountTokensResponse, error) {
			if len(contents) > 0 && len(contents[0].Parts) > 0 {
				capturedText = contents[0].Parts[0].Text
			}
			return &genai.CountTokensResponse{TotalTokens: 100}, nil
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

	assert.Equal(t, "Please summarize:\nThis is the email body.", capturedText)
}

// --- E2E Tests: Token Tracking Not Recorded on Failure ---

func TestE2E_Summarize_TokensNotRecordedOnFailure(t *testing.T) {
	originalKey := *geminiAPIKey
	defer func() { *geminiAPIKey = originalKey }()

	fake := &fakeGeminiClient{
		generateContentFunc: func(ctx context.Context, model string, contents []*genai.Content) (*genai.GenerateContentResponse, error) {
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
