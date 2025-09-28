package utils

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseCloudmailin(t *testing.T) {
	tests := []struct {
		name         string
		input        string
		expectedInfo MailInfo
	}{
		{
			name: "basic email parsing",
			input: `{
				"headers": {
					"from": "sender@example.com",
					"to": "recipient@example.com",
					"date": "2023-01-01T10:00:00Z",
					"subject": "Test Subject"
				},
				"html": "<p>Test HTML content</p>",
				"plain": "Test plain content"
			}`,
			expectedInfo: MailInfo{
				From:    "sender@example.com",
				To:      "recipient@example.com",
				Date:    "2023-01-01T10:00:00Z",
				Subject: "Test Subject",
				Content: "Test HTML content", // Should be converted from HTML
			},
		},
		{
			name: "fallback to plain text when HTML conversion fails",
			input: `{
				"headers": {
					"from": "sender@example.com",
					"to": "recipient@example.com",
					"date": "2023-01-01T10:00:00Z",
					"subject": "Test Subject"
				},
				"html": "",
				"plain": "Test plain content"
			}`,
			expectedInfo: MailInfo{
				From:    "sender@example.com",
				To:      "recipient@example.com",
				Date:    "2023-01-01T10:00:00Z",
				Subject: "Test Subject",
				Content: "Test plain content",
			},
		},
		{
			name: "remove URLs from content",
			input: `{
				"headers": {
					"from": "sender@example.com",
					"to": "recipient@example.com",
					"date": "2023-01-01T10:00:00Z",
					"subject": "Test Subject"
				},
				"html": "",
				"plain": "Check this link (https://example.com/very/long/url) for more info"
			}`,
			expectedInfo: MailInfo{
				From:    "sender@example.com",
				To:      "recipient@example.com",
				Date:    "2023-01-01T10:00:00Z",
				Subject: "Test Subject",
				Content: "Check this link () for more info",
			},
		},
		{
			name: "outlook forwarded email with FW prefix",
			input: `{
				"headers": {
					"from": "sender@example.com",
					"to": "recipient@example.com",
					"date": "2023-01-01T10:00:00Z",
					"subject": "FW: Original Subject"
				},
				"envelope": {
					"helo_domain": "outlook.office365.com"
				},
				"html": "",
				"plain": "Forwarded content"
			}`,
			expectedInfo: MailInfo{
				From:    "sender@example.com",
				To:      "recipient@example.com",
				Date:    "2023-01-01T10:00:00Z",
				Subject: "Original Subject", // FW: prefix should be removed
				Content: "Forwarded content",
			},
		},
		{
			name: "cloudmailin forwarded email parsing",
			input: `{
				"headers": {
					"from": "forwarder@example.com",
					"to": "recipient@cloudmailin.net",
					"date": "2023-01-01T10:00:00Z",
					"subject": "Forwarded Subject"
				},
				"html": "",
				"plain": "content\r\n_____\r\nFrom: John Smith original@sender.com\r\nForwarded content"
			}`,
			expectedInfo: MailInfo{
				From:    "original@sender.com",   // Should extract original sender
				To:      "forwarder@example.com", // Should swap to/from
				Date:    "2023-01-01T10:00:00Z",
				Subject: "Forwarded Subject",
				Content: "content\r\n_____\r\nFrom: John Smith original@sender.com\r\nForwarded content",
			},
		},
		{
			name: "cloudmailin forwarded email without proper format",
			input: `{
				"headers": {
					"from": "forwarder@example.com",
					"to": "recipient@cloudmailin.net",
					"date": "2023-01-01T10:00:00Z",
					"subject": "Forwarded Subject"
				},
				"html": "",
				"plain": "No proper forwarding format"
			}`,
			expectedInfo: MailInfo{
				From:    "sender unknown", // Fallback when regex doesn't match
				To:      "forwarder@example.com",
				Date:    "2023-01-01T10:00:00Z",
				Subject: "Forwarded Subject",
				Content: "No proper forwarding format",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ParseCloudmailin(tt.input)

			assert.Equal(t, tt.expectedInfo.From, result.From)
			assert.Equal(t, tt.expectedInfo.To, result.To)
			assert.Equal(t, tt.expectedInfo.Date, result.Date)
			assert.Equal(t, tt.expectedInfo.Subject, result.Subject)

			// For content, we'll check if it contains expected text since HTML conversion may vary
			if tt.expectedInfo.Content != "" {
				assert.Contains(t, result.Content, strings.TrimSpace(tt.expectedInfo.Content))
			}
		})
	}
}

func TestParseCloudmailin_EmptyInput(t *testing.T) {
	result := ParseCloudmailin("{}")

	assert.Equal(t, "", result.From)
	assert.Equal(t, "", result.To)
	assert.Equal(t, "", result.Date)
	assert.Equal(t, "", result.Subject)
	assert.Equal(t, "", result.Content)
}

func TestParseCloudmailin_InvalidJSON(t *testing.T) {
	result := ParseCloudmailin("invalid json")

	// gjson should handle invalid JSON gracefully and return empty strings
	assert.Equal(t, "", result.From)
	assert.Equal(t, "", result.To)
	assert.Equal(t, "", result.Date)
	assert.Equal(t, "", result.Subject)
	assert.Equal(t, "", result.Content)
}

func TestMailInfo_Struct(t *testing.T) {
	// Test that MailInfo struct works as expected
	info := MailInfo{
		From:    "from@example.com",
		To:      "to@example.com",
		Date:    "2023-01-01",
		Subject: "Test",
		Content: "Content",
	}

	require.Equal(t, "from@example.com", info.From)
	require.Equal(t, "to@example.com", info.To)
	require.Equal(t, "2023-01-01", info.Date)
	require.Equal(t, "Test", info.Subject)
	require.Equal(t, "Content", info.Content)
}
