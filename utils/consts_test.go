package utils

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestConstants(t *testing.T) {
	t.Run("KeyGRPCClients constant", func(t *testing.T) {
		assert.Equal(t, "grpcClients", KeyGRPCClients)
		assert.NotEmpty(t, KeyGRPCClients)
	})

	t.Run("system prefix constant", func(t *testing.T) {
		assert.Equal(t, "[Todofy System]", SystemAutomaticallyEmailPrefix)
	})

	t.Run("default prompt constants", func(t *testing.T) {
		assert.NotEmpty(t, DefaultPromptToSummaryEmail)
		assert.NotEmpty(t, DefaultPromptToSummaryEmailRange)

		// Check that prompts contain expected keywords
		assert.Contains(t, DefaultPromptToSummaryEmail, "summary")
		assert.Contains(t, DefaultPromptToSummaryEmail, "email")
		assert.Contains(t, DefaultPromptToSummaryEmail, "chinese")
		assert.Contains(t, DefaultPromptToSummaryEmail, "concise")

		assert.Contains(t, DefaultPromptToSummaryEmailRange, "rank")
		assert.Contains(t, DefaultPromptToSummaryEmailRange, "importance")
		assert.Contains(t, DefaultPromptToSummaryEmailRange, "Important")
		assert.Contains(t, DefaultPromptToSummaryEmailRange, "Urgent")
		assert.Contains(t, DefaultPromptToSummaryEmailRange, "Normal")
		assert.Contains(t, DefaultPromptToSummaryEmailRange, "Low Priority")
	})

	t.Run("prompt format and requirements", func(t *testing.T) {
		// Check that summary email prompt has required formatting instructions
		prompt := DefaultPromptToSummaryEmail
		assert.Contains(t, prompt, "IMPORTANT:")
		assert.Contains(t, prompt, "markdown")
		assert.Contains(t, prompt, "1-2 sentences")

		// Check that range summary prompt has categorization instructions
		rangePrompt := DefaultPromptToSummaryEmailRange
		assert.Contains(t, rangePrompt, "IMPORTANT:")
		assert.Contains(t, rangePrompt, "four categories")
		assert.Contains(t, rangePrompt, "mac email app")
	})

	t.Run("email prefix format", func(t *testing.T) {
		// The prefix should be in brackets for easy identification
		assert.True(t, len(SystemAutomaticallyEmailPrefix) > 0)
		assert.Contains(t, SystemAutomaticallyEmailPrefix, "[")
		assert.Contains(t, SystemAutomaticallyEmailPrefix, "]")
	})

	t.Run("prompt language specifications", func(t *testing.T) {
		// Check language requirements in prompts
		assert.Contains(t, DefaultPromptToSummaryEmail, "chinese as response language")

		// Range summary should use plain text (no markdown)
		assert.Contains(t, DefaultPromptToSummaryEmailRange, "no markdown")
		assert.Contains(t, DefaultPromptToSummaryEmailRange, "readable for mac email app")
	})
}
