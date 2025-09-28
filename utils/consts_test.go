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

	t.Run("system email constants", func(t *testing.T) {
		assert.Equal(t, "[Todofy System]", SystemAutomaticallyEmailPrefix)
		assert.Equal(t, "me@ziyixi.science", SystemAutomaticallyEmailSender)
		assert.Equal(t, "xiziyi2015@gmail.com", SystemAutomaticallyEmailReceiver)
		assert.Equal(t, "Ziyi Xi", SystemAutomaticallyEmailReceiverName)

		// Check that email addresses look valid
		assert.Contains(t, SystemAutomaticallyEmailSender, "@")
		assert.Contains(t, SystemAutomaticallyEmailReceiver, "@")
		assert.NotEmpty(t, SystemAutomaticallyEmailReceiverName)
	})

	t.Run("default prompt constants", func(t *testing.T) {
		assert.NotEmpty(t, DefaultpromptToSummaryEmail)
		assert.NotEmpty(t, DefaultpromptToSummaryEmailRange)

		// Check that prompts contain expected keywords
		assert.Contains(t, DefaultpromptToSummaryEmail, "summary")
		assert.Contains(t, DefaultpromptToSummaryEmail, "email")
		assert.Contains(t, DefaultpromptToSummaryEmail, "chinese")
		assert.Contains(t, DefaultpromptToSummaryEmail, "concise")

		assert.Contains(t, DefaultpromptToSummaryEmailRange, "rank")
		assert.Contains(t, DefaultpromptToSummaryEmailRange, "importance")
		assert.Contains(t, DefaultpromptToSummaryEmailRange, "Important")
		assert.Contains(t, DefaultpromptToSummaryEmailRange, "Urgent")
		assert.Contains(t, DefaultpromptToSummaryEmailRange, "Normal")
		assert.Contains(t, DefaultpromptToSummaryEmailRange, "Low Priority")
	})

	t.Run("prompt format and requirements", func(t *testing.T) {
		// Check that summary email prompt has required formatting instructions
		prompt := DefaultpromptToSummaryEmail
		assert.Contains(t, prompt, "IMPORTANT:")
		assert.Contains(t, prompt, "markdown")
		assert.Contains(t, prompt, "1-2 sentences")

		// Check that range summary prompt has categorization instructions
		rangePrompt := DefaultpromptToSummaryEmailRange
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
		assert.Contains(t, DefaultpromptToSummaryEmail, "chinese as response language")

		// Range summary should use plain text (no markdown)
		assert.Contains(t, DefaultpromptToSummaryEmailRange, "no markdown")
		assert.Contains(t, DefaultpromptToSummaryEmailRange, "readable for mac email app")
	})
}
