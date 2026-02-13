package main

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	pb "github.com/ziyixi/protos/go/todofy"
)

func TestLLMServer_Summarize(t *testing.T) {
	// Note: These tests focus on validation logic that can be tested
	// without external dependencies. Full integration tests would require
	// actual API keys and network calls.

	t.Run("unsupported model family", func(t *testing.T) {
		server := &llmServer{}

		req := &pb.LLMSummaryRequest{
			ModelFamily: pb.ModelFamily_MODEL_FAMILY_UNSPECIFIED,
			Text:        "Content to summarize",
			Prompt:      "Please summarize this text:",
		}

		resp, err := server.Summarize(context.Background(), req)

		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "unsupported model family")
	})

	t.Run("supported model family passes validation", func(t *testing.T) {
		// This test will fail at the API call stage, but validates
		// that the model family validation passes
		server := &llmServer{}

		req := &pb.LLMSummaryRequest{
			ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
			Text:        "Content to summarize",
			Prompt:      "Please summarize this text:",
			Model:       pb.Model_MODEL_GEMINI_2_5_PRO,
		}

		// We expect this to fail because no API key is set
		resp, err := server.Summarize(context.Background(), req)

		assert.Error(t, err)
		assert.Nil(t, resp)
		// Should not fail on model family validation
		assert.NotContains(t, err.Error(), "unsupported model family")
	})
}

func TestLLMServer_SummaryInternal(t *testing.T) {
	t.Run("validates model in list", func(t *testing.T) {
		server := &llmServer{}

		// Test with an unsupported model (using UNSPECIFIED as invalid)
		summary, model, err := server.summaryInternal(
			context.Background(),
			pb.ModelFamily_MODEL_FAMILY_GEMINI,
			"prompt",
			"text",
			[]pb.Model{pb.Model_MODEL_UNSPECIFIED},
			1024,
		)

		assert.Error(t, err)
		assert.Empty(t, summary)
		assert.Equal(t, pb.Model_MODEL_UNSPECIFIED, model)
		assert.Contains(t, err.Error(), "unsupported model")
	})

	t.Run("validates supported models exist in mapping", func(t *testing.T) {
		server := &llmServer{}

		// Test with valid models that exist in our mapping
		// This will fail at API call but should pass model validation
		for _, model := range llmModelPriority[:1] { // Just test first model
			summary, returnedModel, err := server.summaryInternal(
				context.Background(),
				pb.ModelFamily_MODEL_FAMILY_GEMINI,
				"prompt",
				"text",
				[]pb.Model{model},
				1024,
			)

			assert.Error(t, err) // Expected to fail at API call
			assert.Empty(t, summary)
			assert.Equal(t, pb.Model_MODEL_UNSPECIFIED, returnedModel)
			// Should not fail on unsupported model
			assert.NotContains(t, err.Error(), "unsupported model")
		}
	})
}

func TestLLMServer_TryGenerateSummary(t *testing.T) {
	t.Run("unsupported model family", func(t *testing.T) {
		server := &llmServer{}

		summary, err := server.tryGenerateSummary(
			context.Background(),
			pb.ModelFamily_MODEL_FAMILY_UNSPECIFIED,
			"prompt",
			"text",
			pb.Model_MODEL_GEMINI_2_5_PRO,
			1024,
		)

		assert.Error(t, err)
		assert.Empty(t, summary)
		assert.Contains(t, err.Error(), "unsupported model family")
	})

	t.Run("supported model family routes to correct handler", func(t *testing.T) {
		server := &llmServer{}

		// This should route to summaryByGemini and fail there due to missing API key
		summary, err := server.tryGenerateSummary(
			context.Background(),
			pb.ModelFamily_MODEL_FAMILY_GEMINI,
			"prompt",
			"text",
			pb.Model_MODEL_GEMINI_2_5_PRO,
			1024,
		)

		assert.Error(t, err)
		assert.Empty(t, summary)
		// Should not fail on model family routing
		assert.NotContains(t, err.Error(), "unsupported model family")
	})
}

func TestLLMServer_SummaryByGemini(t *testing.T) {
	t.Run("fails without API key", func(t *testing.T) {
		server := &llmServer{}

		// Ensure API key is not set for this test
		originalKey := *geminiAPIKey
		*geminiAPIKey = ""
		defer func() { *geminiAPIKey = originalKey }()

		summary, err := server.summaryByGemini(
			context.Background(),
			"prompt",
			"content",
			pb.Model_MODEL_GEMINI_2_5_PRO,
			1024,
		)

		assert.Error(t, err)
		assert.Empty(t, summary)
		assert.Contains(t, err.Error(), "gemini-api-key is empty")
	})

	t.Run("validates model exists in mapping", func(t *testing.T) {
		server := &llmServer{}

		// Set a dummy API key to pass the key check
		originalKey := *geminiAPIKey
		*geminiAPIKey = "dummy-key"
		defer func() { *geminiAPIKey = originalKey }()

		// Use an unsupported model
		summary, err := server.summaryByGemini(
			context.Background(),
			"prompt",
			"content",
			pb.Model_MODEL_UNSPECIFIED,
			1024,
		)

		assert.Error(t, err)
		assert.Empty(t, summary)
		assert.Contains(t, err.Error(), "unsupported model")
	})
}

func TestModelSelection(t *testing.T) {
	t.Run("uses priority order for model selection", func(t *testing.T) {
		// Test that models are tried in priority order
		expectedFirst := pb.Model_MODEL_GEMINI_2_5_FLASH_LITE
		expectedSecond := pb.Model_MODEL_GEMINI_2_5_FLASH

		assert.Equal(t, expectedFirst, llmModelPriority[0])
		assert.Equal(t, expectedSecond, llmModelPriority[1])
	})

	t.Run("all priority models have names", func(t *testing.T) {
		for i, model := range llmModelPriority {
			name, exists := llmModelNames[model]
			assert.True(t, exists, "Priority model at index %d should have a name", i)
			assert.NotEmpty(t, name, "Model name should not be empty for priority model at index %d", i)
		}
	})
}

func TestTokenLimitHandling(t *testing.T) {
	t.Run("token limit constant is reasonable", func(t *testing.T) {
		assert.Greater(t, tokenLimit, int32(100000), "Token limit should be reasonably high")
		assert.Equal(t, int32(1048576), tokenLimit, "Token limit should match expected value")
	})

	t.Run("max tokens parameter handling", func(t *testing.T) {
		server := &llmServer{}

		// Test with custom maxTokens - this will fail at API call but validates parameter handling
		originalKey := *geminiAPIKey
		*geminiAPIKey = "dummy-key"
		defer func() { *geminiAPIKey = originalKey }()

		req := &pb.LLMSummaryRequest{
			ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
			Text:        "test content",
			Prompt:      "summarize",
			MaxTokens:   512,
		}

		// This will fail at the API call, but validates that maxTokens is processed
		_, err := server.Summarize(context.Background(), req)
		assert.Error(t, err) // Expected to fail at API call
		// Should not fail on parameter validation
		assert.NotContains(t, err.Error(), "unsupported model family")
	})
}
